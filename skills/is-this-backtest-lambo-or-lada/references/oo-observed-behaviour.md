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
