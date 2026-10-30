---
name: vrp-daily
description: Computes the daily volatility risk premium (VRP) at a fixed entry time or over 26 entries per day - ATM straddle (IV, RV, VRP), model-free semivariance (down, up, total, also in variance form), BKM moment premia (varp, skewp, kurtp), leg VRP, range RV and log form, with tau or equal weighting - after a preflight that checks every input, and imports it as a TradeBlocks daily dataset with lookahead-safe timing. Use when IV, RV or VRP per day, downside or upside VRP, or moment premia are needed, e.g. to test a VRP entry filter.
compatibility: Requires a TradeBlocks MCP server with daily datasets (import_daily_dataset) and read access to its data directory (market.duckdb), as with a local install. SPX minute bars in TradeBlocks; IV from option quotes in TradeBlocks (market.option_quote_minutes) or from Option Omega strangle and straddle blocks. Python 3.9+ with duckdb, numpy and scipy. The script never fetches data.
metadata:
  author: carsten
  version: "2.1.0"
---

# Daily VRP at a fixed entry time

Builds one row per trading day, at one entry time (single mode) or aggregated over 26 entries (multi mode): the ATM-straddle IV, RV and VRP (v1 columns), model-free implied, realized and risk premium split into downside, upside and total, and on request the variance form, moment premia, leg VRP, range RV and log form. The script is a menu of calculation rules; it ranks nothing. The result becomes a TradeBlocks daily dataset with correct timing. Definitions and limits: [references/definitions.md](references/definitions.md).

## Prerequisites

- TradeBlocks MCP server with `import_daily_dataset`; read access to its data directory (the script opens `market.duckdb` read-only).
- `python3` with `duckdb numpy scipy` (`pip install duckdb numpy scipy`).
- The choices of step 1 (variants, mode, entry time, weighting), made by the user. In single mode the entry time is the only time used for IV and for the RV window; computation is always on the trading-time basis.

## Process

```
- [ ] 1 State the setup (variants, mode, entry time, weighting, period) and get the user's confirmation
- [ ] 2 Name the IV source (quotes in TradeBlocks, else OO blocks)
- [ ] 3 Preflight (--check); fix gaps with the named skill
- [ ] 4 Compute
- [ ] 5 Import as dataset and verify
```

### 1. Fix the setup with the user

Before computing, fix these with the user, with no silent choice by the agent:

- the **variant(s)**: ATM straddle columns (always included); model-free semivariance (default columns) with `--center spot|forward`; variance form `--sum-var`; BKM moment premia `--moments`; leg VRP `--leg`; range RV `--range-rv`; log form `--ln`; realized return frequency `--rv-freq 5m|1m`;
- the **mode**: `single` with an entry time (HH:MM, US Eastern) or `multi` (26 entries 09:32..15:45);
- the **weighting** (multi): `--weight tau|equal`, applied to all variants of the run;
- underlying (SPX unless named) and period.

State in one short line the setup you will compute with: what the user named, and for anything open the defaults (single mode at 09:45; multi with `--weight tau`). Ask the user to confirm it. Once confirmed, use that setup for the rest of the session and ask again only if the user changes it. If the user asks about the options, explain them neutrally (what each column is, units, what it needs); do not recommend one. The script refuses `--mode multi` without `--weight`, and single mode without `--entry`, so always pass the confirmed values explicitly.

### 2. Name the IV source

1. **Option quotes in TradeBlocks.** `run_sql`: `SELECT COUNT(*) FROM market.option_quote_minutes WHERE underlying = 'SPX'`. If rows exist for the period, the script uses them (0DTE contracts at the entry minute, mid of bid and ask, OTM only, zero-bid strikes dropped as in the CBOE rule).
2. **Option Omega blocks.** Otherwise `list_blocks`: an ATM straddle block plus 0DTE short strangle blocks (one put and one call per trade, held to expiry) that include trades at the entry time. Use only blocks run with slippage 0 and commission 0, so the premiums are mid prices (the literature standard). Slippage belongs in strategy simulations, not in IV estimation; reject a block with slippage and name the reason. A good set is the straddle plus 40/30/25/20/16/10/7/5/3/2/1 delta strangles. Pass each with `--block <id>` (repeatable; the script reads `<data-dir>/<id>/tradelog.csv`) or `--tradelog <csv>`.
3. **Neither:** the preflight says what is missing; see step 3. Quotes are used for a day when they give at least 4 put and 4 call nodes, else the blocks.

### 3. Preflight

```bash
python3 scripts/vrp_daily.py --check --market-db <data-dir>/market.duckdb --entry HH:MM   --block <straddle-block> --block <strangle-block> ... [--from YYYY-MM-DD --to YYYY-MM-DD] [--json]
```

Per day it checks SPX minute bars (at least 80 % of the bars to 16:00 and the entry bar) and the IV source (at least 4 OTM put and 4 OTM call nodes). It prints a summary and the missing items, each naming the skill that fixes it, and exits with code 3 if anything blocks. Half-days (13:00 close) are listed and skipped.

**The skill and script never fetch data.** Relay the missing items to the user and use the named skill only with their agreement: [market-data](../market-data/SKILL.md) for bars (`fetch_bars`) or quotes (`fetch_quotes`, or `import_option_archive` from a local Parquet archive on TradeBlocks 4.6+; import the full 0DTE chain of each day, since a narrower slice would leave strikes missing for the model-free terms), [oo-capture](../oo-capture/SKILL.md) for Option Omega runs - a new backtest uses the user's allowance and needs their consent. Run the preflight again afterwards.

### 4. Compute

```bash
python3 scripts/vrp_daily.py --market-db <data-dir>/market.duckdb --entry HH:MM   --block <straddle-block> --block <strangle-block> ...   --out vrp_daily_HHMM.csv --dataset <data-dir>/_imports/<path>/vrp_mf_HHMM.csv [--wings flat|trunc|slope] [--center spot|forward] [--rv-freq 5m|1m] [--sum-var] [--moments] [--leg] [--range-rv] [--ln]
```

Multi mode (quotes only): `python3 scripts/vrp_daily.py --market-db <data-dir>/market.duckdb --mode multi --weight tau|equal --out vrp_daily_multi.csv [--per-entry entries.csv] [options above]`. Each column of the day is aggregated over the entries with the chosen weight and needs at least 20 valid entries, else it is empty; `n_entries` and `weight` are in the row. `--leg`, `--center forward` and multi need quotes in `market.option_quote_minutes`. `--check` in multi mode lists days with fewer than 20 valid entries.

The preflight runs first; with gaps the script stops (exit 3). `--allow-gaps` skips the incomplete days and lists them; say so in the result. Incremental by default (`--force` recomputes). Realized volatility, the 5-minute semivariances and the bar coverage are computed in SQL on `market.spot` (window functions); Python only inverts IV, builds the smile and integrates. `--trades db` reads the `--block` trades with SQL from `trades.trade_data` in `<data-dir>/analytics.duckdb` instead of `tradelog.csv` (the table has no `Opening Price`, so the spot is the entry-bar open; see the definitions). Check `--wings trunc` and `--wings slope` for a sensitivity range on the wing assumption. Report numbers only from the output; with OO fills the far strikes are rounded to the minimum tick, see the definitions.

### 5. Import and verify

`list_daily_datasets` first; never overwrite an existing dataset, use a new name such as `vrp_mf_HHMM`. Then `import_daily_dataset` with the dataset CSV (a `csvPath` under the server's data root), the underlying as `ticker` and this timing:

| Column | Timing | Why |
|---|---|---|
| `iv`, `iv_down`, `iv_up`, `iv_mf`, `iv_down_var`, `iv_up_var`, `q_var`, `q_skew`, `q_kurt` (single mode) | `open`, `knownBy` = entry time | known at entry |
| `rv`, `vrp`, `rv_5m`, `vrp_5m`, `rv_down`, `rv_up`, `vrp_down`, `vrp_up`, `vrp_mf` and all other columns (`*_var` realized, `vrp_sum_var`, `p_*`, `varp`, `skewp`, `kurtp`, `leg_*`, `rv_range`, `vrp_range`, `lnvrp*`) | `close` | need the rest of the day; usable from the next day |
| every column in multi mode | `close` | the daily value uses entries up to 15:45 |

The script prints the exact `open`/`close` lists as a `timing:` line when it writes `--dataset`; use those.

Verify with `list_daily_datasets` (rows, coverage) and `list_analysis_fields` (timing per field). A same-day filter may use the `iv*` fields only; `rv*`/`vrp*` apply as prior-day values.

## Interpretation Reference

See [references/definitions.md](references/definitions.md): formulas, the trading-time basis, the semivariance definitions (down and up add in variance, not in vol points), wing variants, source differences, variance form, BKM moments, leg VRP, range RV, log form, multi mode and weighting, timing, units and limits.

## Related Skills

- [Parameter exploration](../optimize/SKILL.md): test a VRP field with `filter_curve` and `suggest_filters`.
- [oo-capture](../oo-capture/SKILL.md): import Option Omega straddle and strangle backtests.
- [market-data](../market-data/SKILL.md): load minute bars and option quotes.

## What NOT to Do

- Don't fetch data or run an Option Omega backtest from this skill; report the need and name the skill. New backtests only with the user's consent.
- Don't use same-day `rv*` or `vrp*` to filter same-day trades; they are only known at the close.
- Don't fill missing days with estimates; skip and report them.
- Don't choose a variant, mode, entry time or weighting for the user, and don't recommend or rank them; ask in step 1.
- Don't mix entry times: the IV nodes and the RV window must start at the same minute.
- Don't add `iv_down` and `iv_up` in vol points; add the variances (see definitions).
