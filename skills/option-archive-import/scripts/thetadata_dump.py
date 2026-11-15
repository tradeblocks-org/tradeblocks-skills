#!/usr/bin/env python3
"""Dump ThetaData 1-minute option quotes into a local Parquet archive, one file per root and day.

  <out>/<ROOT>/0dte/<YYYY>/<YYYY-MM-DD>.parquet    --mode 0dte: only the expiration that expires that day
  <out>/<ROOT>/chain/<YYYY>/<YYYY-MM-DD>.parquet   --mode chain: every expiration quoted that day

Both modes work on a ThetaData VALUE subscription (bulk requests by expiration; single-contract
requests need STANDARD). VALUE allows 2 concurrent requests, which are used inside one session.
Resumable: <out>/<ROOT>/manifest_<mode>.jsonl lists finished days. ThetaData allows one session
per account, so nothing else (e.g. a TradeBlocks ThetaData provider) may use the account while this runs.

Measured on VALUE for SPXW: 0dte ~15 s and ~0.5 MB per day; chain ~4-8 M rows, 15-40 MB and
~4-5 minutes per day (one request per expiration; a single expiration='*' stream was reset
by the server regularly).

Requires: pip install thetadata polars   (API key in THETADATA_API_KEY or --key-file)
Example:  thetadata_dump.py --out ~/option-archive --root SPXW --mode 0dte --from 2020-01-01 --to 2026-10-16
"""
import argparse
import datetime as dt
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


def log(*a):
    print(dt.datetime.now().strftime("%H:%M:%S"), *a, flush=True)


class NoAccess(Exception):
    pass


def out_path(out, root, mode, day):
    return Path(out) / root / mode / str(day.year) / f"{day.isoformat()}.parquet"


def weekdays(start, end):
    d, days = start, []
    while d <= end:
        if d.weekday() < 5:
            days.append(d)
        d += dt.timedelta(days=1)
    return days


def retry(fn, label, no_data_error, tries=5):
    for k in range(tries):
        try:
            return fn()
        except no_data_error:
            return None
        except Exception as e:  # network or server hiccup
            msg = str(e)
            if "PERMISSION_DENIED" in msg:
                raise NoAccess(msg[:300]) from None
            if "INVALID_ARGUMENT" in msg:
                return None
            log(f"  retry {k + 1} {label}: {type(e).__name__}: {msg[:150]}")
            time.sleep(15 * (k + 1))
    raise RuntimeError(f"giving up {label}")


def fetch_day(c, pl, nde, root, day, mode):
    q = lambda exp: c.option_history_quote(root, expiration=exp, interval="1m", date=day, strike="*", right="both")
    if mode == "0dte":
        return retry(lambda: q(day), f"{root} {day}", nde)
    contracts = retry(lambda: c.option_list_contracts("quote", day, symbol=root), f"{root} {day} list", nde)
    if contracts is None or not contracts.height:
        return None
    exps = sorted({str(x)[:10] for x in contracts["expiration"].to_list()})
    parts = []
    with ThreadPoolExecutor(max_workers=2) as ex:
        futs = [ex.submit(retry, lambda e=e: q(dt.date.fromisoformat(e)), f"{root} {day} exp {e}", nde) for e in exps]
        for f in as_completed(futs):
            df = f.result()  # a give-up fails the whole day; it is retried on the next run
            if df is not None and df.height:
                parts.append(df)
    return pl.concat(parts, how="vertical_relaxed") if parts else None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--root", default="SPXW")
    ap.add_argument("--mode", choices=["0dte", "chain"], default="0dte")
    ap.add_argument("--from", dest="frm", required=True)
    ap.add_argument("--to", required=True)
    ap.add_argument("--key-file")
    a = ap.parse_args(argv)

    import polars as pl
    from thetadata import ThetaClient
    from thetadata.errors import NoDataFoundError

    key = Path(a.key_file).read_text().strip().split("=", 1)[-1] if a.key_file else os.environ.get("THETADATA_API_KEY")
    if not key:
        sys.exit("set THETADATA_API_KEY or pass --key-file")
    manifest = Path(a.out) / a.root / f"manifest_{a.mode}.jsonl"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    have = {json.loads(l)["date"] for l in manifest.read_text().splitlines() if l.strip()} if manifest.exists() else set()
    days = [d for d in weekdays(dt.date.fromisoformat(a.frm), dt.date.fromisoformat(a.to)) if d.isoformat() not in have]
    log(f"{len(days)} days to fetch ({a.root}, {a.mode})")
    c = ThetaClient(api_key=key, dataframe_type="polars")
    failed = 0
    for i, day in enumerate(days, 1):
        t0 = time.time()
        try:
            df = fetch_day(c, pl, NoDataFoundError, a.root, day, a.mode)
        except NoAccess as e:
            sys.exit(f"no access for {a.root} {day} on this subscription: {e}")
        except Exception as e:
            failed += 1
            log(f"[{i}/{len(days)}] {day} FAILED {type(e).__name__}: {str(e)[:200]}")
            continue
        entry = {"date": day.isoformat(), "rows": 0, "status": "no_data", "fetch_s": round(time.time() - t0, 1)}
        if df is not None and df.height:
            p = out_path(a.out, a.root, a.mode, day)
            p.parent.mkdir(parents=True, exist_ok=True)
            df.write_parquet(p, compression="zstd", compression_level=9, statistics=True)
            entry.update(status="ok", rows=df.height, bytes=p.stat().st_size,
                         contracts=df.select(["expiration", "strike", "right"]).n_unique())
        with manifest.open("a") as f:
            f.write(json.dumps(entry) + "\n")
        log(f"[{i}/{len(days)}] {day} {entry['status']} {entry['rows']:,} rows {entry['fetch_s']}s")
    log(f"done, {failed} failed day(s){' - re-run to retry' if failed else ''}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
