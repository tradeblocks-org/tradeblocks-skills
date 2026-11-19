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

## Intra-minute stops

The setting is `exitConditions[].useIntraMinuteStop` (one boolean per exit group). Option Omega honours it only for SPX and SPY and only while every leg of that exit group is 0 DTE. C8 applies when any group has it `true` and those conditions hold; the `minute_stop` run sets it `false` in every group.

## Exit slippage and closing-order profit targets

A profit target set as a closing order near zero (e.g. buy back at 0.05) interacts with `exitSlippage`: the target appears to fill only when the price **including** the exit slippage reaches it. With an exit slippage of 0.05 such a target never filled and the trades ran to expiry; with 0 it filled. Re-costing alone can therefore change which exits a strategy takes.

Real case (0 DTE SPX iron condor, 15.5k trades): the author run (exit slippage 0.05) had Expired 10,737 / Profit Target 0 / Stop 4,805; the same run with only the five cost fields changed to a scenario with exit slippage 0 had Expired 86 / Profit Target 10,493 / Stop 4,963. Inferred from the exit-reason counts and the settings diff, not from Option Omega documentation. Re-run with exit slippage 0.05 in both: Profit Target 0 again (author_base Expired 10,443 / Stop 5,099).

**Expiry pays no exit slippage (observed).** The naive run (no profit target, no stop, every trade held to expiry) built once with exit slippage 0 and once with 0.05, all else equal: same 15,542 trades, all Expired, same net P/L to the cent. A run whose trades all expire does not depend on `exitSlippage`.

Consequence: author_base must trade like the author run. The verdict script compares their exit-reason shares and caps when the largest difference is above `thresholds.json` → `exitMix`; the cost file needs an explicit `exitSlippage` per scenario (never assumed 0).
