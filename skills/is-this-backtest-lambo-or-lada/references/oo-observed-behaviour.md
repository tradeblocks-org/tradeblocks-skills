# Option Omega behaviour the checks rely on

Observed in saved Option Omega backtests, not taken from Option Omega documentation. Re-check when Option Omega changes its engine; a different behaviour changes how C3 and the run request read, not the thresholds.

## Entry days and holidays

An entry rule such as "every Monday" skips an exchange holiday; the entry is **not** moved to the next session. Example: with Monday entries, the holiday Mondays 2013-01-21 and 2013-02-18 have no trade and neither do the Tuesdays after them; the next entries are 2013-01-28 and 2013-02-25.

Consequence for C3: a rule day is a matching weekday that is an NYSE session. `get_rule_calendar` never counts a holiday as a missing entry.

## Days to expiry

DTE is counted in **calendar days** from the entry date to the expiry.

Without exact DTE, Option Omega takes the **first available expiry with DTE at or above the target**. Example, target 45 DTE, Monday entries in 2013 (monthly and quarterly expiries only):

| Entry | Expiry taken | DTE |
|---|---|---|
| 2013-01-07 | Mar 28 | 80 |
| 2013-02-11 | Mar 28 | 45 |
| 2013-02-25 | Jun 28 | 123 |

In years without weekly or daily expiries a stated DTE is therefore often not what the backtest traded. C3 calls `get_rule_calendar` with `selection: "firstAtLeast"` for such runs: entries above the target are reported in the per-year mismatch share (and cap the verdict above the threshold), entries below the target break the rule. With exact DTE use `selection: "exact"`.

TradeBlocks has no per-day listing of available expiries, so it cannot say which expiry should have been taken on a given day; the rule calendar reports the DTE that was actually traded per year.

## End of the backtest range

Option Omega never reports a close after `rangeEnd` (observed: 7 DTE SPX put spread, entry on the Monday that is `rangeEnd`, expiry a week later):
- `closeOpenTradesAtTestCompletion: false`: the entry on `rangeEnd` is opened but left open. It is **not** in the trade log; the result reports it only as `numberOfOpenTrades`.
- `closeOpenTradesAtTestCompletion: true`: the same entry is closed **on** `rangeEnd` with `reasonClosed: "Backtest Completed"`, closing fees and exit costs charged.

Consequence for C3: an entry on a rule day whose earliest expiry (entry date + DTE) is after `rangeEnd` is not in the trade log (first behaviour), so it is not a missing rule day: C3 passes `rangeEnd` as `recordEnd` and `get_rule_calendar` lists such days in `unobservableRuleDays`. A rule day whose expiry is on or before `rangeEnd` and has no trade still counts as missing; 0 DTE is never affected.

Consequence for C4: every trade of a run closes inside its own range, so the range is the run's coverage and a TradeBlocks refusal for a trade outside it means the block does not match the ranges (C4 not run). For the exit-mix guard one "Backtest Completed" exit per run is the end of the test, not a trading decision, and is left out; any further one counts as "other". The synthetic fixtures follow the first behaviour.

## Intra-minute stops

The setting is `exitConditions[].useIntraMinuteStop` (one boolean per exit group). Option Omega honours it only for SPX and SPY while every leg of the group is 0 DTE. On a group without a stop loss it refuses the settings file: "useIntraMinuteStop needs a stop loss (maxLoss, or a profit action's stopLoss)". Observed on a 0 DTE SPX iron fly whose only exit was a 20-point underlying move, and on the same fly whose only stop was the `stopLoss` 100 of a switched-on time action at 12:00. On a 0 DTE SPX iron condor the P&L with intra-minute stops was clearly lower than with minute stops, so a minute run reads too positive. The rule the run request follows: [run-request.md](run-request.md).

## Settings fields

- A profit action's `stopLoss` is measured from the premium when the action fires, not from the entry premium (Option Omega's `run_backtest` schema).
- `roundStrikesToNearest` 0 is no rounding step (off), as 0 is for `maxContractsPerTrade` and `capitalPerContract`.

## Exit slippage and closing-order profit targets

A profit target set as a closing order near zero (e.g. buy back at 0.05) interacts with `exitSlippage`: the target appears to fill only when the price **including** the exit slippage reaches it. With a non-zero exit slippage of the size of the target such a target never filled and the trades ran to expiry; with 0 it filled. Re-costing alone can therefore change which exits a strategy takes.

Example (one real 0 DTE SPX case, re-costed with only the cost fields changed): closing-order profit-target exits fell from over 10,000 to 0 when the exit slippage went from 0 to the author's value; the trades expired instead. Inferred from the exit-reason counts and the settings diff, not from Option Omega documentation.

**Expiry pays no exit slippage (observed).** In the same case the naive run (no profit target, no stop, every trade held to expiry) was built with two different exit slippages, all else equal: the trade logs were byte-identical. A run whose trades all expire does not depend on `exitSlippage`.
