# Run request: the runs a triage needs

The skill never runs Option Omega. `scripts/triage-run-request.mjs` writes the list for a plug-in or the user, who builds each run from the author run, exports it into the triage block with the given label, and adds the label to `triage.json`. At most four runs.

Every run starts as a copy of the **author run** and changes only the fields listed. Everything else stays: underlying, structure, legs and strike rule, DTE and the exact-DTE setting, entry days, entry times, date range.

**Costs.** Every run a check reads is on the user's **base cost scenario**, read through the local config (`costs.file` or `costs.command` → `{ "scenarios": { "<name>": { "entrySlippage", "exitSlippage", "stopLossSlippage", "openingFees", "closingFees" } } }`, values in Option Omega's own units). No cost value is taken from the author's backtest or from this skill.

## author_base (only when the author's costs differ from the base scenario)

The author run with the five cost fields set to the base scenario. It replaces the author run in every check. Without it, a triage of a run off the base costs is at most unclear.

## naive (always; feeds C4 and C3's missing rule days)

The author run minus every optional lever, at base costs, held to the structure's natural end:

| Field group | Change |
|---|---|
| Costs | the base scenario |
| Profit target | off: `maxProfit` null, `useProfitActions` false, `profitActions` empty |
| Stops | off: `maxLoss` null, `isTrailingStopLoss` false, `useIntraMinuteStop` false |
| Time and tested exits | off: `useTimeActions` false, `timeActions` empty, `exitAtDte` / `exitAtDit` / `exitAtMit` / `exitTime` null, `exitWhenPutTested` / `exitWhenCallTested` false |
| Entry filters | off: every set `entryMin*` / `entryMax*` / VIX / SMA / EMA filter null, `useOpeningRangeBreakout` false |
| Re-entry | off: `reentryConditions` empty |
| Sizing rules | off: one fixed contract count per entry (`maxContractsPerTrade` = the author's, default 1), `capitalPerContract` null |
| Exit | hold to the natural end: expiry of the short leg; for a calendar, the front leg's expiry |

## cost_2x (always; feeds C7)

The author's rules with the base scenario's slippage × 2 (`entrySlippage`, `exitSlippage`, `stopLossSlippage`), base fees. If the local config names a 2x scenario (`costs.cost2x`), that scenario is used instead.

## minute_stop (only when Option Omega honours the author's intra-minute stops; feeds C8)

The author's rules at base costs with `exitConditions[].useIntraMinuteStop` set to `false` in every exit group. Option Omega honours intra-minute stops only for SPX and SPY while every leg is 0 DTE ([oo-observed-behaviour.md](oo-observed-behaviour.md)).

## Output

```
{
  "flags": { "author_costs_match_base": false, "author_uses_intra_minute_stops": true },
  "baseScenario": "<name>",
  "runs": [
    { "role": "author_base", "label": "<author> base-costs", "from": "author", "set": { <cost fields> } },
    { "role": "naive", "label": "<author> naive", "from": "author",
      "set": { <cost fields>, <entry filters: null>, "maxContractsPerTrade": 1, ... },
      "exitConditions": [ { "maxProfit": null, "maxLoss": null, ... } ] },
    { "role": "cost_2x", "label": "<author> slip2x", "from": "author", "set": { <slippage x 2, base fees> } },
    { "role": "minute_stop", "label": "<author> minute-stop", "from": "author", "set": { <cost fields> },
      "exitConditions": [ { "useIntraMinuteStop": false } ] }
  ]
}
```

`set` overwrites top-level settings fields; `exitConditions[i]` overwrites fields of the author's i-th exit group. Copy both flags into `triage.json` (`author_costs_match_base`, `oo_settings.useIntraMinuteStop`).
