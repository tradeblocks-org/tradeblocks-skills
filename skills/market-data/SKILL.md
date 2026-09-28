---
name: market-data
description: Set up market data for TradeBlocks analysis. Guides through fetching daily and intraday bars, VIX context, and option quotes from a provider, or importing minute bars from CSV or DuckDB. Use when market data is missing, regime analysis shows no matches, or replay returns empty paths.
compatibility: Requires TradeBlocks MCP server. Provider fetching requires credentials for the selected provider (e.g., MASSIVE_API_KEY for Massive).
---

# Market Data Setup

Guide the user through importing market data so other skills (DC analysis, health checks, replay) have the data they need.

## When This Skill Triggers

- `enrich_trades` returns warnings about missing market data
- `analyze_regime_performance` returns "No trades matched to market data"
- `replay_trade` returns 0 minute bars / $0 P&L
- `batch_exit_analysis` returns mostly `noTrigger` with $0 P&L
- User says "import market data", "set up market data", "I need VIX data", etc.

## Step 1: Diagnose What's Missing

Ask the user what they're trying to do, then check what data exists:

Use `run_sql` with `query` to inspect coverage (and `describe_database` if the schema is unfamiliar):

```sql
-- Daily bars derived from spot data
SELECT ticker, COUNT(*) AS days, MIN(date) AS earliest, MAX(date) AS latest
FROM market.spot_daily GROUP BY ticker ORDER BY ticker
```

```sql
-- Underlying intraday bars
SELECT ticker, COUNT(*) AS bars, MIN(date) AS earliest, MAX(date) AS latest
FROM market.spot GROUP BY ticker ORDER BY ticker
```

```sql
-- Minute option quotes used by replay
SELECT underlying, COUNT(DISTINCT ticker) AS contracts,
  MIN(date) AS earliest, MAX(date) AS latest
FROM market.option_quote_minutes GROUP BY underlying
```

```sql
-- Cross-ticker regime and term structure
SELECT COUNT(*) AS days, MIN(date) AS earliest, MAX(date) AS latest
FROM market.enriched_context
```

Present what's available and what's missing for their goal.

## Step 2: Determine the Right Data Source

### For Regime Analysis (VIX regimes, term structure, enriched trades)

**Minimum needed:** Daily bars for the underlying and for VIX, VIX9D, VIX3M. Fetch all three VIX tickers before computing cross-ticker context.

| What to fetch | Tool | Example arguments |
|---------------|------|-------------------|
| Underlying daily (SPX or QQQ) | `fetch_bars` | `tickers: ["SPX"], from: "2023-02-14", to: "2024-12-31", timespan: "1d"` |
| VIX-family daily bars | `fetch_bars` | `tickers: ["VIX", "VIX9D", "VIX3M"], from: "2023-02-14", to: "2024-12-31", timespan: "1d"` |
| Cross-ticker context | `compute_vix_context` | `from: "2023-02-14", to: "2024-12-31"` |

**Order matters:** `fetch_bars` writes spot bars and auto-enriches each ticker. Once all three VIX-family tickers are ingested and enriched, call `compute_vix_context` for the same date range. Never compute context on a partially loaded VIX family.

**Useful flags on `fetch_bars`:**
- `dry_run: true` — preview without writing
- `skip_enrichment: true` — defer per-ticker enrichment; if used, call `enrich_market_data` for **each** ticker before `compute_vix_context`

**Provider coverage:** Massive index bars start 2023-02-14; choose dates the active provider actually covers. `to` takes a YYYY-MM-DD date, not `"today"`.

**Date range:** Match the trade data range. Check with:
```sql
SELECT MIN(date_opened) as earliest, MAX(date_opened) as latest
FROM trades.trade_data WHERE block_id = '<block>'
```

### For Trade Replay (minute-level P&L paths, greeks, exit trigger simulation)

**Needed:** Minute option quotes for each OCC leg and minute underlying spot bars for the same trade dates. `replay_trade` reads the local cache only; it does not auto-fetch missing data.

1. Decide which trades you will analyze. `batch_exit_analysis` takes the newest `limit` trades (default 50, max 200) after its optional `strategy`, `date_range`, `min_pl` and `max_pl` filters, so read the legs and dates of exactly that set with `run_sql`, using the same filters and limit:
```sql
SELECT legs, date_opened FROM trades.trade_data
WHERE block_id = '<block>'
  -- AND strategy ILIKE '%<strategy>%'  AND date_opened >= '<from>'  AND date_opened <= '<to>'
ORDER BY date_opened DESC LIMIT 50
```

2. Obtain the OCC tickers from every returned trade's legs, then call `fetch_quotes` for them over those trades' dates, e.g. `tickers: ["SPXW260320P06410000"]`, `from: "2026-03-20"`, `to: "2026-03-20"`. Use the actual trade dates and provider coverage; for supported ThetaData bulk fetching, `underlyings: ["SPX"]` can replace `tickers`.
3. Call `fetch_bars` with `tickers: ["SPX"]`, the same `from` and `to`, and `timespan: "1m"` for underlying spot bars.
4. Run `replay_trade` for one of the prepared trades, or `batch_exit_analysis` with the same `block_id`, filters and `limit` you used in step 1, so it replays only trades whose data is cached. Trades it reports as skipped are missing cached data.

**Note:** Provider option coverage varies. Missing quotes or underlying bars can yield degenerate replay; inspect coverage before trusting a $0 result.

### For TradingView CSV Import

`import_market_csv` imports **minute bars** into spot; daily bars and indicators are derived from the intraday data. For a TradingView minute-bar CSV whose `time` column is a Unix timestamp, map that column to `date`: the parser extracts the time automatically. Do not present a daily-only CSV as minute bars.

```json
{
  "file_path": "~/Downloads/SPX_1m.csv",
  "ticker": "SPX",
  "column_mapping": {
    "time": "date",
    "open": "open",
    "high": "high",
    "low": "low",
    "close": "close"
  },
  "dry_run": true
}
```

Use `dry_run: true` first to inspect the mapping; then repeat without it to write. VIX-family CSV imports also update cross-ticker context, but import all three before verifying derived context.

### For External DuckDB Import

`import_from_database` imports **minute bars** from a read-only attached DuckDB file, with `ext_import_source` as the table alias. Map query columns to spot bar fields:

```json
{
  "db_path": "~/data/market.duckdb",
  "query": "SELECT date, time, open, high, low, close FROM ext_import_source.spx_minutes",
  "ticker": "SPX",
  "column_mapping": {
    "date": "date",
    "time": "time",
    "open": "open",
    "high": "high",
    "low": "low",
    "close": "close"
  },
  "dry_run": true
}
```

## Step 3: Fetch or Import

Run the fetches or imports based on what's missing. Common recipes:

### Recipe: Full SPX Setup (regime + enrichment)
1. `fetch_bars`: `tickers: ["SPX"]`, `from: "2023-02-14"`, `to: "2024-12-31"`, `timespan: "1d"`
2. `fetch_bars`: `tickers: ["VIX", "VIX9D", "VIX3M"]`, same dates and `timespan: "1d"`
3. Once all three VIX tickers are enriched, `compute_vix_context`: same `from` and `to`

### Recipe: Full QQQ Setup
1. `fetch_bars`: `tickers: ["QQQ"]`, the chosen `from` and `to`, `timespan: "1d"`
2. Fetch the VIX family and compute context as above (shared across underlyings)

### Recipe: Replay Data for a Block
1. Select the trades to analyze with the same filters and `limit` that `batch_exit_analysis` will use (see For Trade Replay, step 1)
2. `fetch_quotes` for every selected trade's OCC tickers and dates
3. `fetch_bars` for the underlying with `timespan: "1m"` over the same dates
4. Run `replay_trade`, or `batch_exit_analysis` with those same filters and `limit`, against the cached quotes and bars

## Step 4: Verify

After fetching or importing, verify the data is available using `run_sql`:

```sql
-- Check daily coverage
SELECT ticker, COUNT(*) AS days, MIN(date) AS earliest, MAX(date) AS latest
FROM market.spot_daily GROUP BY ticker ORDER BY ticker
```

```sql
-- Check regime data populated
SELECT Vol_Regime, COUNT(*) AS days
FROM market.enriched_context
GROUP BY Vol_Regime ORDER BY Vol_Regime
```

```sql
-- Check term structure populated
SELECT Term_Structure_State, COUNT(*) AS days
FROM market.enriched_context
WHERE Term_Structure_State IS NOT NULL
GROUP BY Term_Structure_State
```

If `Term_Structure_State` is all NULL, check coverage for VIX, VIX9D, and VIX3M, fetch any missing bars, then call `compute_vix_context` for the complete range.

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `enrich_trades` shows null VIX3M fields | VIX3M spot bars missing | `fetch_bars` for VIX3M, then `compute_vix_context` after all three VIX tickers are enriched |
| `Term_Structure_State` all NULL | VIX-family bars or context missing | Fetch all three VIX tickers, then `compute_vix_context` |
| `analyze_regime_performance` returns 0 matched | No underlying daily bars | `fetch_bars` for the underlying with `timespan: "1d"` |
| `replay_trade` returns 0 bars | Cached option quotes or underlying minute bars missing | `fetch_quotes` for OCC tickers and `fetch_bars` for the underlying with `timespan: "1m"` |
| Enrichment fields missing (RSI, ATR) | Per-ticker enrichment skipped | Run `enrich_market_data` with `ticker` for each affected ticker |
| Provider fetch returns 0 rows | Date range outside provider coverage | Check the provider's available date range |
| CSV import fails on column mapping | Wrong column names | Use `dry_run: true` first to preview |

## Cleanup

`purge_market_table` accepts only `table: "daily" | "date_context" | "intraday"`; it deletes **all** rows in that table and its sync metadata, not one ticker or date range. Inspect coverage and confirm the scope with the user before using it to repair corrupted data.

## What NOT to Do

- Don't assume a single VIX import computes complete context — ingest all three VIX-family tickers before `compute_vix_context`
- Don't assume all date ranges have data — Massive index bars start 2023-02-14
- Don't skip per-ticker enrichment — without it RSI and other per-ticker fields won't be populated, and context computation needs enriched VIX data
- Don't fetch the same data twice without checking — repeated calls waste provider usage
