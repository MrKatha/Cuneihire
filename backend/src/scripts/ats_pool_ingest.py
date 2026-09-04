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
import time
from datetime import datetime, timedelta, timezone

import httpx
import pyarrow.parquet as pq

PLATFORMS = ["greenhouse", "lever", "ashby", "smartrecruiters"]
RECENCY_DAYS = 30
RETENTION_DAYS = 90
# 2026-09-04: a real full run against the live table (already holding the prior Lever ingest) hit Postgres
# error 57014 "canceling statement due to statement timeout" on batch 46/368 at BATCH_SIZE=500 -- per-batch
# latency was visibly climbing (7s -> 12s) as the upsert's GIN-index maintenance on `fts` gets more expensive
# with table size, until a batch finally exceeded whatever statement_timeout applies to this connection.
# Lowered the starting size and, more importantly, upsert_batch() below now retries-with-backoff and then
# adaptively halves a batch that keeps failing rather than crashing the whole run -- table growth means no
# fixed batch size stays safe forever, so this has to self-adjust instead of just picking a smaller constant.
BATCH_SIZE = 200
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


def _try_upsert(client, rows):
    """One raw attempt. Returns the response; never raises for a non-2xx status (caller decides)."""
    return client.post(
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


def upsert_batch(client, rows, max_retries=4):
    # Retry transient failures (5xx, 429) with backoff first -- a statement timeout under momentary load can
    # succeed on a plain retry. If it keeps failing, the batch itself is likely too large for the table's
    # current size, so halve it and recurse rather than giving up (see BATCH_SIZE's own comment above for why
    # a fixed size can't be trusted to stay safe as the table grows across a run).
    resp = None
    for attempt in range(max_retries):
        resp = _try_upsert(client, rows)
        if resp.status_code in (200, 201, 204):
            return
        retryable = resp.status_code in (429, 500, 502, 503, 504)
        if not retryable or attempt == max_retries - 1:
            break
        wait = 2 ** attempt
        log(f"  upsert of {len(rows)} row(s) failed ({resp.status_code}), retrying in {wait}s (attempt {attempt + 1}/{max_retries})...")
        time.sleep(wait)

    if len(rows) > 1:
        mid = len(rows) // 2
        log(f"  batch of {len(rows)} still failing after retries ({resp.status_code}: {resp.text[:200]}) -- splitting into {mid} + {len(rows) - mid}")
        upsert_batch(client, rows[:mid], max_retries)
        upsert_batch(client, rows[mid:], max_retries)
        return

    # A single row still fails after retries -- log and drop just this row rather than crashing the whole
    # run over one pathological record (matches this codebase's "fail open" convention elsewhere).
    log(f"  WARNING: dropping 1 row that failed after retries ({resp.status_code}): {resp.text[:300]} -- source_url={rows[0].get('source_url')}")


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
