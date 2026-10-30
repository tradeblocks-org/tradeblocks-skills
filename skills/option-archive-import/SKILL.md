---
name: option-archive-import
description: Loads 1-minute option quotes from a local Parquet day-file archive (e.g. a ThetaData dump) into TradeBlocks with the import_option_archive tool - date range, DTE range, calls/puts and a strike band - after a dry run, with per-day row checks, safe handling of days that already hold data, and resume. Includes a script that builds such an archive from ThetaData. Use when replay or exit analysis needs option quotes that are not in TradeBlocks yet, when keeping option history after a data subscription ends, or when loading many days without one provider request per day.
compatibility: Requires a TradeBlocks MCP server with import_option_archive (TradeBlocks 4.6+) and run_sql; the archive files must be readable by the server. Building an archive needs Python 3.9+ with thetadata and polars and a ThetaData account.
metadata:
  author: carsten
  version: "1.0.0"
---

# Option archive import

Moves option quotes from Parquet day files into TradeBlocks without contacting a data provider. TradeBlocks' `import_option_archive` does the work (filters, per-day writes, row-count checks, day classification); the skill agrees the selection with the user, runs the dry run, drives the import to completion and checks the result.

## Prerequisites

- `import_option_archive` and `run_sql` in the server's tool list (TradeBlocks 4.6+). Without it, say so and stop; do not import day by day with `import_flat_file` instead.
- An archive the server can read: one Parquet file per trading day, the day as `YYYY-MM-DD` in the path, columns `expiration`, `strike`, `right`, `timestamp`, `bid`, `ask` (optionally `symbol`). The exact contract is in the tool description. `scripts/thetadata_dump.py` builds one from ThetaData (see [Building an archive](#building-an-archive)).
- The path is the one the **server** sees. With Docker, use the path inside the container (a directory under the mounted data root).
- For a strike band: the underlying's minute bars in `market.spot`; days without them fall back to put-call parity at 09:35 ET, and `strikeReference` reports which was used.

## Process

```
- [ ] 1 Agree the selection
- [ ] 2 Dry run and report the plan
- [ ] 3 Import until nothing remains
- [ ] 4 Check the result
```

### 1. Agree the selection

With the user: `path`, `from`/`to`, `underlying`, `dteMin`/`dteMax`, `rights`, `strikePct` or `strikeMin`/`strikeMax`.

- **Ticker root.** Default is the file's `symbol` column. Trade-log replay builds tickers from the trade log's underlying (e.g. `SPX...` for Option Omega SPX trades, while daily SPX options trade as `SPXW`). If the user will replay such trades, pass `tickerRoot: "SPX"`; otherwise keep the default. Say which root you chose.
- **Existing days.** A write replaces the whole (underlying, date) partition. The default `onExisting: "skip"` leaves days that already hold option data untouched. `replace` is only for a deliberate rewrite (widening a selection, repairing a mismatched or interrupted day); ask before using it and list the days it will rewrite.

### 2. Dry run

`import_option_archive` with the selection and `dryRun: true`. Report `estimate` (days, quote rows), the sampled `days.planned`, and the counts of `days.skippedExisting`, `days.missingInArchive`, `days.nonTradingDays`. If `skippedExisting` covers days the user wants changed, return to step 1 (that needs `replace`).

### 3. Import

The same call without `dryRun`. A call imports at most `maxDays` days (default 100); while `days.remaining` is not empty, call again with the same arguments: with `skip`, finished days are skipped, so the import resumes. Accumulate the results across calls.

### 4. Check

- `days.mismatched` and `days.errors` must be empty. A mismatched day has been written; rerun just that day with `onExisting: "replace"`. An error day was not written (or was restored); report the message.
- Report `days.noMatchingRows`, `days.noReferencePrice`, `days.unclassifiedDays` (imported days outside the server's holiday calendar, where only weekends are excluded) and any `days.offDateRows`.
- Confirm with `run_sql`: distinct dates and row count in `market.option_quote_minutes` for the underlying and range. If the user replays trades, run `replay_trade` on one trade in the range and confirm minute bars come back.

## Interpretation Reference

| Result | Meaning |
|---|---|
| `days.ok` | Written; chain and quote counts equal a count of the same selection |
| `days.skippedExisting` | Already held option data; untouched (`skip`) |
| `days.missingInArchive` | No file for a session day: holiday before the server's calendar, no expiration that day, or not archived |
| `days.nonTradingDays` | Known exchange closures; never imported, even if the archive has a file |
| `days.mismatched` | Written, but a count differs; rerun with `replace` |
| `days.remaining` | Not reached in this call (`maxDays`); call again |

Size in TradeBlocks is roughly 5 MB per million quote rows. SPXW 0DTE is about 0.1-0.5 M rows per day; a full SPXW chain 4-10 M, so filter the chain by DTE and strike.

## Building an archive

`scripts/thetadata_dump.py` downloads 1-minute NBBO quotes from ThetaData into `<out>/<ROOT>/0dte/<YYYY>/<date>.parquet` (same-day expirations) or `<out>/<ROOT>/chain/<YYYY>/<date>.parquet` (all expirations), resumable through a manifest. It works on a ThetaData VALUE subscription (requests by expiration). ThetaData allows one session per account: nothing else, including a TradeBlocks ThetaData provider, may use the account while it runs. ThetaData can return quotes for some exchange holidays; `import_option_archive` skips known closures. `python scripts/thetadata_dump.py --help` for options; `scripts/test_thetadata_dump.py` covers the path and calendar helpers.

## What NOT to Do

- Don't use `onExisting: "replace"` to import a narrower slice over days that hold broader data; it deletes what the new selection leaves out.
- Don't run two imports at the same time.
- Don't pass a host path the server cannot see.

## Related Skills

- [market-data](../market-data/SKILL.md): underlying bars, VIX context and provider fetches.
