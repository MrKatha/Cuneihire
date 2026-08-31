#!/usr/bin/env python3
"""
Thin bridge script around JobSpy (https://github.com/speedyapply/JobSpy, MIT license) — the only way to
call it is a Python function, there's no CLI, so this is that CLI: reads one JSON object of search
parameters from stdin, calls scrape_jobs(), writes a JSON array of listings to stdout. No state, no DB
access, no retries — jobspyBridge.js (the Node caller) owns error handling/timeouts.

v1 is deliberately Indeed-only (see docs/architecture.md's "Open-source job sourcing" section) — LinkedIn
via JobSpy needs proxies to be reliable ("proxies are a must basically" per JobSpy's own docs), a real
recurring cost this pass explicitly defers. `site_name` is still a parameter (not hardcoded) so that
decision can change later without touching this script.

Input (stdin, one JSON object): {"search_term": str, "location": str, "results_wanted": int,
"site_name": [str, ...]}
Output (stdout, one JSON array): [{"title", "company", "location", "job_type", "min_amount", "max_amount",
"job_url", "description", "emails", "site"}, ...] — a trimmed, JSON-safe subset of JobSpy's own DataFrame
columns (NaN/NaT don't survive json.dumps, so they're normalized to null/empty first).
"""
import sys
import json

def main():
    try:
        raw = sys.stdin.read()
        params = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON on stdin: {e}"}), file=sys.stderr)
        sys.exit(1)

    search_term = params.get("search_term")
    if not search_term:
        print(json.dumps({"error": "search_term is required"}), file=sys.stderr)
        sys.exit(1)

    try:
        from jobspy import scrape_jobs
    except ImportError:
        print(json.dumps({"error": "python-jobspy is not installed (pip install -U python-jobspy)"}), file=sys.stderr)
        sys.exit(1)

    try:
        df = scrape_jobs(
            site_name=params.get("site_name", ["indeed"]),
            search_term=search_term,
            location=params.get("location") or None,
            results_wanted=params.get("results_wanted", 20),
            description_format="markdown",
        )
    except Exception as e:  # JobSpy's own failure modes aren't documented as a closed set — never let this
        # script crash silently with a non-JSON stderr dump the Node side can't parse.
        print(json.dumps({"error": f"scrape_jobs failed: {e}"}), file=sys.stderr)
        sys.exit(1)

    listings = []
    if df is not None and len(df) > 0:
        # NaN (pandas' "no value") isn't valid JSON — .where(...) swaps every NaN for None first, which
        # json.dumps then renders as null, unlike a raw float("nan") which json.dumps would reject outright.
        safe_df = df.where(df.notnull(), None)
        for row in safe_df.to_dict(orient="records"):
            listings.append({
                "title": row.get("title") or "",
                "company": row.get("company") or "",
                "location": row.get("location") or "",
                "job_type": row.get("job_type") or "",
                "min_amount": row.get("min_amount"),
                "max_amount": row.get("max_amount"),
                "job_url": row.get("job_url") or "",
                "description": row.get("description") or "",
                "emails": row.get("emails") or [],
                "site": row.get("site") or "",
            })

    print(json.dumps(listings))

if __name__ == "__main__":
    main()
