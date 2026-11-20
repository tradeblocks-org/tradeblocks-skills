# Option Omega behaviour the checks rely on

Observed in saved Option Omega backtests, not taken from Option Omega documentation. Re-check when Option Omega changes its engine; a different behaviour changes how C3 and C8 read, not the thresholds.

## Entry days and holidays

An entry rule such as "every Monday" skips an exchange holiday; the entry is **not** moved to the next session. Example: with Monday entries, the holiday Mondays 2013-01-21 and 2013-02-18 have no trade and neither do the Tuesdays after them; the next entries are 2013-01-28 and 2013-02-25.

Consequence for C3: a rule day is a matching weekday that is an NYSE session. `get_rule_calendar` never counts a holiday as a missing entry.

An entry filter (any filter in the author run's settings) skips rule days on purpose, so the author run's own missing-day share says nothing about the calendar. C3 therefore reads missing rule days from the **naive** run, which keeps the calendar but drops the filters, and the DTE mismatch from the **author** run. Until the naive run exists, the missing-day part of C3 is not run and caps the verdict.

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

Consequence for C4: every trade of a run closes inside its own range, so the range is the run's coverage and a TradeBlocks refusal for a trade outside it means the block does not match the ranges (C4 not run). For the exit-mix guard one "Backtest Completed" exit per run is the end of the test, not a trading decision, and is left out; any further one counts as "other". The synthetic fixtures follow the first behaviour.

## Intra-minute stops

The setting is `exitConditions[].useIntraMinuteStop` (one boolean per exit group). Option Omega honours it only for SPX and SPY and only while every leg of that exit group is 0 DTE. C8 applies when any group has it `true` and those conditions hold; the `minute_stop` run sets it `false` in every group.

## Exit slippage and closing-order profit targets

A profit target set as a closing order near zero (e.g. buy back at 0.05) interacts with `exitSlippage`: the target appears to fill only when the price **including** the exit slippage reaches it. With a non-zero exit slippage of the size of the target such a target never filled and the trades ran to expiry; with 0 it filled. Re-costing alone can therefore change which exits a strategy takes.

Example (one real 0 DTE SPX case, re-costed with only the cost fields changed): closing-order profit-target exits fell from over 10,000 to 0 when the exit slippage went from 0 to the author's value; the trades expired instead. Inferred from the exit-reason counts and the settings diff, not from Option Omega documentation.

**Expiry pays no exit slippage (observed).** In the same case the naive run (no profit target, no stop, every trade held to expiry) was built with two different exit slippages, all else equal: the trade logs were byte-identical. A run whose trades all expire does not depend on `exitSlippage`.

Consequence: author_base must trade like the author run. The verdict script compares their exit-reason shares; above `thresholds.json` → `exitMix` author_base counts as a different strategy and C4–C8 are not run. The cost file needs an explicit `exitSlippage` per scenario (never assumed 0).
