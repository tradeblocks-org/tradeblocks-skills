# Run request: the runs a triage needs

The skill never runs Option Omega. It writes this list for a plug-in or the user, who builds each run from the author run, exports it into the triage block with the given label, and adds the label to `triage.json`.

Every run starts as a copy of the **author run**. Keep everything not listed here unchanged: underlying, structure, legs and strike rule, DTE and the exact-DTE setting, entry days, entry time, date range, sizing.

## naive (always; feeds C4)

The author run minus every optional lever, exiting at the structure's natural end:

| Field group | Change |
|---|---|
| Profit target | off: `maxProfit` removed, `useProfitActions` false |
| Extra stops | off: `maxLoss` removed, every stop exit group removed |
| Time exits | off: `useTimeActions` false, `exitAtDte` / `exitAtDit` / `exitAtMit` removed |
| Entry filters | off: every `entryMin*` / `*Max*` filter removed, `useOpeningRangeBreakout` false |
| Re-entry | off: `reentryConditions` removed |
| Sizing rules | off: one fixed contract count per entry (`maxContractsPerTrade` = the author run's per-trade size), no allocation-based sizing |
| Exit | hold to the natural end: expiry of the short leg; for a calendar, the front leg's expiry |

Costs stay at the base scenario (`entrySlippage`, `exitSlippage`, `stopLossSlippage`, `openingFees`, `closingFees` as in the author run).

## cost_2x (always; feeds C7)

The author run with slippage doubled from the user's cost file: `entrySlippage`, `exitSlippage` and `stopLossSlippage` each × 2. Fees (`openingFees`, `closingFees`) unchanged. No cost value is ever taken from this skill.

## minute_stop (only when the author run uses intra-minute stops; feeds C8)

The author run with `exitConditions[].useIntraMinuteStop` set to `false` in every exit group. See [oo-observed-behaviour.md](oo-observed-behaviour.md) for when Option Omega honours the setting.

## Request format

One line per missing run, for example:

```
naive       <author label>-naive    copy of <author label>; profit target off, stops off, time exits off, entry filters off, re-entry off; hold to short-leg expiry
cost_2x     <author label>-slip2x   copy of <author label>; entrySlippage, exitSlippage, stopLossSlippage x 2
```

At most three extra runs per triage.
