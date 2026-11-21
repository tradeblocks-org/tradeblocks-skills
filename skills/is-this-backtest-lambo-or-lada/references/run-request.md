# Run request: the runs a triage needs

The skill never runs Option Omega. `scripts/triage-run-request.mjs` writes the list for a plug-in or the user, who builds each run from the author run, exports it into the triage block with the given label, and adds the label to `triage.json`. At most four runs.

Every run starts as a copy of the **author run** and changes only the fields listed. Everything else stays: underlying, structure, legs and strike rule, DTE and the exact-DTE setting, entry days, entry times, date range. The date range of every run goes into `triage.json` → `run_ranges`; C4 passes it to TradeBlocks as each run's coverage, so a day without a position counts as 0 $ only while that run was running.

**Costs.** Every run a check reads is on the user's **base cost scenario**, read through the local config: `costs.file` = your filled copy of [templates/costs.json](../templates/costs.json), or `costs.command` printing the same JSON (`{ "scenarios": { "<name>": { "entrySlippage", "exitSlippage", "stopLossSlippage", "openingFees", "closingFees" } } }`, values in Option Omega's own units). No cost value is taken from the author's backtest or from this skill. Every field of the base (and the 2x) scenario must be a number; a missing, null, empty or non-numeric field stops the script before it writes anything (the first-run setup asks for it first), and nothing is filled with 0. An explicit 0 is kept and listed in `zeroCostFields`.

## author_base (only when the author's costs differ from the base scenario)

The author run with the five cost fields set to the base scenario. It is requested whenever any cost field differs, and also when the author's settings do not state a cost field (unknown is never taken as a match). It replaces the author run in every check, and must trade like it: the verdict script compares their exit-reason mix and caps when it changed (`thresholds.json` → `exitMix`; see [oo-observed-behaviour.md](oo-observed-behaviour.md)). Without it, C4–C8 are not run (they would compare runs at different costs) and the verdict is at most unclear.

## naive (always; feeds C4 and C3's missing rule days)

The author run minus every optional lever, at base costs, held to the structure's natural end. Built **fail closed**: only these settings stay as in the author run, everything else is switched off.

| Stays | Fields |
|---|---|
| Structure, expiry, strike rule | `underlying`, `legs`, `strikeOffsetType`, `useExactDte`, `roundStrikesToNearest` |
| Entry days and times | `entryTime`, `additionalEntryTimes`, `useFloatingEntryTime`, `minEntryTime`, `maxEntryTime`, `weeklyEntries`, `monthlyEntryDay`, `monthlyEntryOrdinal`, `specificEntryDays` |
| Record | `rangeStart`, `rangeEnd`, `startingFunds`, `ignoreMarginRequirements` |
| Exit groups | `id`, `name`, `legIds` |
| Units | every `…Type` field (meaningless once its field is off) |

| Set | Value |
|---|---|
| Costs | the base scenario |
| Size | `maxContractsPerTrade` = the author's (default 1), `allocationPercentage` 0 (one constant contract count per entry) |
| Every other top-level field | booleans false, numbers null, lists empty (filters, re-entry, `capProfits`/`capLosses`, `maxOpenTrades`, opening-range breakout, …) |
| Every other exit-group field | off the same way (profit target, stops incl. per-leg stops and `legExitDeltas`, trailing, time, tested and move exits, intra-minute stops) → hold to expiry of the short leg; for a calendar, the front leg's expiry |

A text field the script does not know cannot be switched off safely; it is kept and listed under `reviewByHand` — check it by hand before building the run.

## cost_2x (always; feeds C7)

The author's rules with the base scenario's slippage × 2 (`entrySlippage`, `exitSlippage`, `stopLossSlippage`), base fees, always computed by the script from the base scenario; the local config names no 2x scenario (a leftover `costs.cost2x` is refused with a message that the field was removed). `zeroCostFields` entries `cost2x.<field>` refer to these computed values.

## minute_stop (only when Option Omega honours the author's intra-minute stops; feeds C8)

The author's rules at base costs with `exitConditions[].useIntraMinuteStop` set to `false` in every exit group. Option Omega honours intra-minute stops only for SPX and SPY while every leg is 0 DTE ([oo-observed-behaviour.md](oo-observed-behaviour.md)).

## Output

```
{
  "flags": { "author_costs_match_base": false, "author_uses_intra_minute_stops": true },
  "baseScenario": "<name>",
  "costsExample": false,
  "zeroCostFields": [ "base.<field>", "cost2x.<field>" ],
  "runRanges": { "author": { "from": "<rangeStart>", "through": "<rangeEnd>" }, "naive": { ... }, ... },
  "costsSha256": "<sha256 of the base and 2x cost values used>",
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

`set` overwrites top-level settings fields; `exitConditions[i]` overwrites fields of the author's i-th exit group. Only fields that change are listed. Copy both flags into `triage.json` (`author_costs_match_base`, `oo_settings.useIntraMinuteStop`), `runRanges` into `run_ranges` (empty when the author settings have no range: C4 then caps) and `costsSha256`, `zeroCostFields` and `costsExample` into the check results. `zeroCostFields` names every cost field that is an explicit 0 (`[]` when none); a base slippage of 0 caps C7. `costsExample` is `true` when the costs are the skill's example scenario (confirmed in the first-run setup) instead of the user's own: the summary and the log then say "costs: example (not your own)" and C7 is capped. A run's identity in the triage is its capture id: put it into `triage.json` → `capture_ids` and from there into the check results as `captureIds` (`null` for a run without one). A slot or saved-backtest id only names where the run passed through in Option Omega, and an Option Omega run id expires about an hour after the run; neither identifies a run.
