# Run request: the runs a triage needs

`scripts/triage-run-request.mjs` writes the runs a triage needs to `<run folder>/run-request.json` and, per role (author included), the author settings plus exactly the listed changes as `<role>.settings.json` (none while `reviewByHand` is not empty), run unchanged after the user's ok ([runs.md](runs.md)).

Every run starts as a copy of the **author run** and changes only the fields listed. Everything else stays: underlying, structure, legs and strike rule, DTE and the exact-DTE setting, entry days, entry times, date range. The output's `range` is that date range; C4 passes it to TradeBlocks as both runs' coverage, so a day without a position counts as 0 $ only while the run was running. Settings without `rangeStart` and `rangeEnd` are refused (`BAD_SETTINGS`).

**Costs.** Every run a check reads is on the user's **base cost scenario** from the local config (SKILL.md step 1; format [templates/costs.json](../templates/costs.json)); no cost value is taken from the author's backtest or from this skill. An explicit 0 is listed in `zeroCostFields`.

## author_base: the realistic run

The realistic run: the author run with the five cost fields set to the base scenario and intra-minute stops where Option Omega offers them. It is requested whenever any cost field differs, and when `flags.author_without_intra_minute` is `true` on the base costs. It replaces the author run in every check but C3, and must trade like it: the verdict script compares their exit-reason mix, and when it changed C4–C9 are not run (`thresholds.json` → `exitMix`; see [oo-observed-behaviour.md](oo-observed-behaviour.md)). Without it, C4–C9 are not run (they would compare runs at different costs) and the verdict is at most unclear.

## naive (always; feeds C4 and C3's missing rule days)

The author run minus every optional lever, at base costs, one constant contract count per entry, held to the structure's natural end (the short leg's expiry; for a calendar, the front leg's). Built **fail closed**: structure, strike rule, expiry, entry days and times, date range, the test-end rule and the quote-quality rule stay; everything else is switched off (the field list and the reasons are in the script). A text field the script does not know cannot be switched off safely: it is kept and listed under `reviewByHand` (`REVIEW_BY_HAND`, no settings files) — check it by hand before building the run.

Settings whose rule-sheet `structure` names a credit spread or an iron condor while a long leg sits on the inner side of its short leg are refused with `INVERTED_SPREAD` ([from-description.md](from-description.md) rule 5). Credit or debit is derived where the settings fix it: a parent offset, both legs on strike offsets, or both on deltas (credit when the short leg has the larger delta); otherwise `strategy-as-built.md` says "credit/debit: not determinable".

## cost_2x (always; feeds C7)

The author's rules with the base scenario's slippage × 2 (`entrySlippage`, `exitSlippage`, `stopLossSlippage`), base fees, always computed by the script from the base scenario; the local config names no 2x scenario.

## stop_tight, stop_wide (only when the author settings have a stop; feed C9)

The realistic run (author_base when it runs, else the author run) with every stop value × 0.75 and × 1.25: `maxLoss` (trailing included) and the `stopLoss` of every switched-on profit or time action. Nothing else changes, intra-minute included. `flags.author_has_stop` says whether they are requested.

## Intra-minute stops (every run)

The script switches intra-minute stops on wherever Option Omega offers them (SPX or SPY, every leg of the exit group 0 DTE, the group has a stop; reasons in [oo-observed-behaviour.md](oo-observed-behaviour.md)). The author run is off only when the rule sheet's `stop_mode` is `minute` with status `stated`; a saved backtest (`built_from` `saved backtest`) keeps its own setting per exit group. With the author run off on a group, `flags.author_without_intra_minute` is `true` and the exit-mix guard compares only profit-target and time shares.

## Output

`run-request.json` holds everything the verdict script reads (flags, costs, `range`, `c8Starts`, `c3MissingDaysRun`, `returnBasis`, `runs`) and the finished TradeBlocks arguments `c3Rule` (get_rule_calendar) and `c8Sql` (C8, the block id left as `<block_id>`); steps 4–6 pass them unchanged, and nothing in it is copied by hand.
