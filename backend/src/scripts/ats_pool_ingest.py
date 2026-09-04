#!/usr/bin/env python3
"""
Batch ingestion for the shared ATS job pool (automailsend_ats_job_pool) -- see that table's own comment
in supabase_setup.sql for the full design rationale. Standalone script, same convention as
jobspy_scrape.py (a real CLI where the underlying library has none) -- but unlike that file, this one is
NOT a Node subprocess bridge: it's triggered directly by a scheduled GitHub Actions workflow
(.github/workflows/ats-pool-ingest.yml), runs there rather than on the production droplet, and talks to
Supabase itself over REST (no Node process involved at all -- there's nothing live to bridge back to,
this is a one-shot batch job).

Why GitHub Actions and not the production server: that box has 911MB total RAM and was confirmed (live,
2026-09-04) to OOM-kill on downloads far smaller than what this script pulls -- a single platform's Parquet
file (e.g. Greenhouse, 128MB) already exceeded what fit alongside the already-running Node app. GH Actions
runners have 7GB+ RAM, so this reads each file in one shot via pyarrow/pandas, no streaming/chunking needed.

Source: https://storage.stapply.ai/jobhive/v1/<platform>/jobs.parquet (MIT-licensed "jobhive" dataset,
ats-scrapers project). No scoped/delta API exists upstream -- full-file download is the only access method
(confirmed by reading ats_scrapers' own client.py: search() downloads the whole file every time regardless
of query params). Real per-platform sizes as of 2026-09-04 (from the dataset's own manifest.json): greenhouse
180,060 rows/128MB, lever 71,058/42MB, ashby 54,894/54MB, smartrecruiters 243,916/120MB -- combined ~550K
rows/~344MB. Workday (814,535 rows/455MB) deliberately excluded for now -- see docs/architecture.md.

Filtering: posted_at >= now - RECENCY_DAYS is mandatory, not optional -- real sampling of the Lever file
found postings back to 2009 mixed with today's; without this filter the pool fills with dead listings.
Rows missing a title or both description+apply_url are dropped as unusable.

Upsert: direct Supabase REST calls (POST .../rest/v1/automailsend_ats_job_pool with
Prefer: resolution=merge-duplicates, on_conflict=source_url) -- same raw-REST convention this project's own
scratch tooling (sb_query.js) already uses, chosen over supabase-py to avoid a second Python dependency
category. Batched (BATCH_SIZE rows per request) to stay well under PostgREST's payload limits.

Retention: after ingesting, deletes pool rows older than RETENTION_DAYS. Safe unconditionally -- this table
is never referenced by a foreign key (see its own schema comment); once atsPool.worker.js finds a match it
copies what it needs into automailsend_job_posts, which has its own independent copy of the text.
"""
import sys
import os
import json
import math
import tempfile
from datetime import datetime, timedelta, timezone

import httpx
import pyarrow.parquet as pq

PLATFORMS = ["greenhouse", "lever", "ashby", "smartrecruiters"]
RECENCY_DAYS = 30
RETENTION_DAYS = 90
BATCH_SIZE = 500
DATASET_BASE = "https://storage.stapply.ai/jobhive/v1"
# A bare httpx/urllib default User-Agent got a flat 403 from this CDN in live testing (2026-09-04);
# curl's default worked fine -- mimicking a normal browser UA sidesteps whatever's filtering on it.
DOWNLOAD_HEADERS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"}

SUPABASE_URL = os.environ.get("ATS_POOL_SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.environ.get("ATS_POOL_SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")


def log(msg):
    print(f"[ats_pool_ingest] {msg}", flush=True)


def download_parquet(platform, dest_path):
    url = f"{DATASET_BASE}/{platform}/jobs.parquet"
    log(f"Downloading {url} ...")
    with httpx.stream("GET", url, headers=DOWNLOAD_HEADERS, timeout=300, follow_redirects=True) as resp:
        resp.raise_for_status()
        with open(dest_path, "wb") as f:
            for chunk in resp.iter_bytes(chunk_size=1024 * 1024):
                f.write(chunk)
    size = os.path.getsize(dest_path)
    log(f"  -> {size / 1_000_000:.1f}MB")
    return dest_path


def clean(v):
    # NaN/NaT (pandas' "no value") isn't JSON-safe -- same gotcha jobspy_scrape.py already documented and
    # works around; float('nan') != float('nan') is the cheapest correct check without importing pandas
    # just for isna() here.
    if v is None:
        return None
    if isinstance(v, float) and v != v:
        return None
    return v


def load_and_filter(platform, path, cutoff):
    table = pq.read_table(path)
    df = table.to_pandas()
    log(f"  {len(df)} raw rows")

    df["posted_at"] = df["posted_at"].apply(lambda v: v if v is None or (isinstance(v, float) and v != v) else v)
    # Recency filter -- mandatory (see module docstring). Rows with an unparseable/missing posted_at are
    # dropped rather than assumed-recent -- no evidence beats false confidence here.
    import pandas as pd
    df["posted_at"] = pd.to_datetime(df["posted_at"], errors="coerce", utc=True)
    df = df[df["posted_at"] >= cutoff]
    log(f"  {len(df)} rows after {RECENCY_DAYS}-day recency filter")

    df = df[df["title"].notna() & (df["title"].astype(str).str.strip() != "")]
    has_desc = df["description"].notna() & (df["description"].astype(str).str.strip() != "")
    has_apply = df["apply_url"].notna() & (df["apply_url"].astype(str).str.strip() != "")
    df = df[has_desc | has_apply]
    log(f"  {len(df)} rows after title/description/apply_url sanity filter")

    rows = []
    for _, r in df.iterrows():
        url = clean(r.get("apply_url")) or clean(r.get("url"))
        if not url:
            continue
        rows.append({
            "source_url": str(url),
            "ats_type": platform,
            "title": str(clean(r.get("title")) or "").strip()[:500],
            "company": clean(r.get("company")),
            "location": clean(r.get("location")),
            "country_iso": clean(r.get("country_iso")) or None,
            "is_remote": bool(r["is_remote"]) if clean(r.get("is_remote")) is not None else None,
            "description": (str(clean(r.get("description")) or ""))[:10000] or None,
            "posted_at": r["posted_at"].isoformat() if r["posted_at"] is not None and not pd.isna(r["posted_at"]) else None,
        })
    return rows


def upsert_batch(client, rows):
    resp = client.post(
        f"{SUPABASE_URL}/rest/v1/automailsend_ats_job_pool",
        params={"on_conflict": "source_url"},
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        content=json.dumps(rows),
        timeout=60,
    )
    if resp.status_code not in (200, 201, 204):
        raise RuntimeError(f"Upsert failed ({resp.status_code}): {resp.text[:500]}")


def prune_old_rows(client, cutoff):
    resp = client.delete(
        f"{SUPABASE_URL}/rest/v1/automailsend_ats_job_pool",
        params={"posted_at": f"lt.{cutoff.isoformat()}"},
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Prefer": "return=minimal",
        },
        timeout=120,
    )
    if resp.status_code not in (200, 204):
        raise RuntimeError(f"Prune failed ({resp.status_code}): {resp.text[:500]}")


def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        log("ERROR: missing ATS_POOL_SUPABASE_URL / ATS_POOL_SUPABASE_SERVICE_ROLE_KEY")
        sys.exit(1)

    dry_run = "--dry-run" in sys.argv
    only = [a.split("=", 1)[1] for a in sys.argv if a.startswith("--only=")]
    platforms = only[0].split(",") if only else PLATFORMS

    cutoff = datetime.now(timezone.utc) - timedelta(days=RECENCY_DAYS)
    retention_cutoff = datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)

    all_rows = []
    # RUNNER_TEMP is GH Actions' own scratch dir when set; tempfile.gettempdir() is the correct
    # cross-platform fallback otherwise (a bare "/tmp" isn't a real path on Windows, where this script is
    # also run directly for local dry-run testing).
    tmp_dir = os.environ.get("RUNNER_TEMP") or tempfile.gettempdir()
    for platform in platforms:
        try:
            path = download_parquet(platform, os.path.join(tmp_dir, f"{platform}_jobs.parquet"))
            rows = load_and_filter(platform, path, cutoff)
            all_rows.extend(rows)
            os.remove(path)
        except Exception as e:
            log(f"WARNING: {platform} failed, skipping: {e}")

    log(f"Total rows to upsert: {len(all_rows)}")

    if dry_run:
        log("--dry-run set, not writing to Supabase.")
        print(json.dumps(all_rows[:3], indent=2))
        return

    with httpx.Client() as client:
        batches = math.ceil(len(all_rows) / BATCH_SIZE)
        for i in range(batches):
            batch = all_rows[i * BATCH_SIZE:(i + 1) * BATCH_SIZE]
            upsert_batch(client, batch)
            log(f"  upserted batch {i + 1}/{batches} ({len(batch)} rows)")

        log(f"Pruning rows older than {RETENTION_DAYS} days...")
        prune_old_rows(client, retention_cutoff)

    log("Done.")


if __name__ == "__main__":
    main()
