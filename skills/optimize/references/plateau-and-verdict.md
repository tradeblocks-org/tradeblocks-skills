# Plateau rule and evidence-limited verdicts

Shared by [is-this-optimum-real](../../is-this-optimum-real/SKILL.md) (an Option Omega optimizer grid) and [is-this-filter-real](../../is-this-filter-real/SKILL.md) (a filter threshold sweep). Both answer the same question: is the best cell of a searched grid real, or the luck of having picked the best? Background on overfitting and multiple testing is in [optimization.md](optimization.md).

## The plateau rule

The best cell of a grid is selected in hindsight, so it is a **lead, not a conclusion**. A real effect changes the metric gradually across neighbouring settings; noise produces isolated spikes. Choose the setting to test from the shape of the grid, with a rule stated **before** choosing:

1. **Metric and direction.** Name the metric the grid is ranked by and whether higher is better.
2. **Neighbours.** Compare adjacent coordinates on the swept axes (the next value of a parameter, the next threshold), not cells that happen to be close in metric rank.
3. **Stability rule.** State the tolerance, connectivity and tie breaker, for example: the connected region of cells whose metric is within a stated tolerance of its local high, with breadth measured by coordinate extent and number of neighbouring cells.
4. **Centre.** Select the central **actual** cell of the broadest stable region. Never interpolate a setting that was not run.
5. **Rule dependence.** Repeat with an alternative tolerance. If the centre or the conclusion changes, say that the result depends on the rule.

Flag each of these as weak or ambiguous evidence:

| Pattern | Reading |
|---|---|
| Best cell on the grid boundary | The effect may continue past the grid, or it is an edge artefact |
| Flat grid | No sensitivity to the parameter; nothing to select |
| Tied regions | No unique plateau; the choice is arbitrary |
| Too few cells, or a region of one or two cells | Not enough neighbourhood to judge stability |
| Sharp cliff next to the best cell | Likely noise |

If the best cell and the centre coincide, test that one setting and say that no best-versus-centre comparison applies; do not invent a second arm.

## Evidence-limited verdict

Report every test with three parts: **its result, the population it used and its limit.** Then:

- Present the grid neighbourhood as a lead, not a finding.
- State whether a test accounts for having selected the setting from the grid. A test on the selected setting that ignores the search is **not adjusted for selection**; say so.
- Diagnostics that reuse the history the setting was selected on (walk-forward, Monte Carlo, edge decay, per-year breakdowns) are **single-tape diagnostics, not out-of-sample confirmation**.
- Never call a setting robust from a rank, a single interval or a single test.
- An interval that crosses zero, or an insufficient-data status, does not prove equivalence. An interval that excludes zero does not correct for grid search.
- Distinguish figures reported by the source (e.g. OO headlines) from figures TradeBlocks recomputed.
- End with the **missing evidence** and a concrete **next discriminating test** (fresh data after a fixed date, a related block, a selection-adjusted test) instead of claiming confirmation.

| Avoid | Prefer |
|---|---|
| "The optimum / filter works" | "The centre improved X in-sample on N trades; not yet tested out of sample" |
| "Robust" from one test | "Passed N of M checks; failed …" |
| "Significant" without selection adjustment | "Not adjusted for selecting the setting from the grid" |
| "Interval includes zero, so they are the same" | "Not distinguishable from zero with this sample" |
