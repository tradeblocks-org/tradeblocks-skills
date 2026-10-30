# Filter robustness: interpretation guide

Filter-specific notes for `is-this-filter-real`. The plateau rule and verdict wording are shared with is-this-optimum-real in [plateau-and-verdict.md](../../optimize/references/plateau-and-verdict.md).

## Why the best threshold is suspect

A sweep over 19 thresholds in two directions is 38 tries. The best of 38 noisy values is biased upward even when the field has no effect, and the bias grows with every extra threshold and field. Expect a real filter to deliver **less** than its best threshold showed, out of sample and live.

## U-shaped curves

If skipping the middle of the distribution helps, so that **both** extreme tails beat the baseline, the field marks unusual days rather than a monotonic edge. Typical causes are a few large P&L days in each tail, or a regime that drives both the field and the P&L. Report both tails and test single-day dependence for each. A one-sided filter chosen from a U-shape tells half the story.

## Single-day dependence

Short-premium and 0DTE blocks often have a handful of days that dominate total P&L. If removing one day turns Δ from clearly positive to near zero or negative, the filter is really a forecast of that day. Report the day, its P&L, and whether the filter keeps or removes it.

## Coverage and carried-forward values

Dataset values attach as of the last observation before the trade; a missing observation is filled from an older one unless `maxMissedSessions` limits it. Stale values make a filter look smoother than it is; refused values reduce coverage. State the limit and compare against the covered baseline, not the full block.

## Per-year rows

`filter_curve` `perYear` applies the **full-sample** threshold to each year. The threshold was chosen with all years in view, so positive years are consistency evidence, not independent confirmation. Treat `lowSampleWarning` rows as anecdotes.

## Out-of-sample split

One chronological split guards against choosing the threshold with knowledge of the later period. It is weak evidence: one split, one history, different regimes in each half. A positive second half supports the candidate; a negative one, or a first half that picks the opposite direction, is a strong warning.

## How the permutation works (TradeBlocks 4.5)

`filter_curve` with `permutation` answers: how often does the **best** threshold of a sweep on shuffled outcomes do at least as well as the observed best?

- **Selection-adjusted:** each shuffle reruns the whole threshold sweep and keeps its best, so the p-value accounts for picking the best threshold.
- **Calendar-month blocks:** outcomes are shuffled in whole months, order kept inside each month. Dependence within a month survives; dependence across months does not.
- **Add-one correction**, `(exceedances + 1) / (iterations + 1)`: with 499 iterations the smallest possible p is 0.002. Results are deterministic for a given seed.
- **Holm** adjusts across the fields of **one request**. Fields tried in other calls are outside the family; count them as extra burden.
- The p-value belongs to the best threshold of the grid in that call. It does not test the plateau centre or a threshold chosen elsewhere.
- With `unit: "day"` the server shuffles daily P&L; risk objectives (`maxDrawdown`, `mar`, `sharpe`) are recomputed for every shuffled sweep, which is far more expensive, so fewer iterations fit the work limit. The add-one floor is then `1 / (iterations + 1)`.

A large p (e.g. 0.5) means sweeps on shuffled data routinely find a threshold as good as the observed one: the best threshold is what searching produces, not evidence of an edge.

## Skip filters and risk reduction

Many filters are meant to skip rare bad days, not to raise P&L. They usually cost some P&L and cut the drawdown. Judge them as insurance:

- Report the P&L given up next to the risk change; never call a skip filter an edge when it costs P&L.
- Count the **removed days**. A filter that skips a few dozen days is judged on those days, often dominated by a handful of large losses.
- Drawdown, MAR and other peak-to-trough metrics depend on a single episode. Name the episode (dates, P&L) and say whether the effect survives without it. A block permutation keeps the month of that episode together, so a small p-value on a drawdown metric can still rest on one episode.
- Test the risk claim with the risk objective (`unit: "day"`), not with the P&L test. Without `minKeptFraction` (TradeBlocks 4.6) the server's `bestThreshold` has no kept floor, so a drawdown best often keeps only a few dozen days; pass the floor and still apply the plateau eligibility rule.
- If many thresholds cut the drawdown by the same amount, one episode sets it. A low p-value then says the filter avoids that episode, not that it avoids drawdowns in general.

## Risk objectives and Kelly sizing

For a risk purpose the skill selects with Sharpe and checks with MAR:

- **Sharpe** uses every day. Under a normal approximation the growth rate at a fixed fraction `c` of Kelly is about `c · (1 − c/2) · Sharpe²` per period, so at ¼ or ⅛ Kelly filters rank exactly as by Sharpe; the fraction sets the size, not the choice of filter.
- **MAR** divides by one number, the largest drawdown, so a filter that avoids that one episode wins in sample whether or not it does anything else. At a fixed Kelly fraction the expected drawdown in percent depends mostly on the fraction, so MAR ranks like Sharpe in expectation but is much noisier on one history. Use it to judge whether the drawdown is bearable, together with the episode's dates.
- **maxDrawdown** alone falls as fewer days are kept; never select by it.
- **Fat left tails.** Short-premium P&L has rare large losses, so Kelly from the actual distribution is smaller than the Sharpe approximation; fractional Kelly is the buffer. Report the worst day (step 7a) next to the planned size.
- **Not available from the server:** Sortino (downside deviation, which suits left-skewed P&L better than Sharpe) and Kelly for the filtered subset (`get_position_sizing` takes no filter and no day unit). Report them as not run.

## Multi-entry blocks

With several entries per day, the filter decides once per day and the entries of a day move together. Trade counts overstate the independent sample. Use `unit: "day"`: the server sums P&L per entry date, counts days and permutes days. It refuses with `day_field_varies` if the field changes within a day; then the field is not a day filter and trade-level results must be read with that caveat.

## Regime context

A breakdown by volatility regime (`filter_curve` `groupBy` + `bins` → `perGroup`, or `analyze_regime_performance`) shows where the P&L comes from. It is context, not evidence for a filter:

- Fix the regime definition (lookback, bucket edges) before looking; a definition chosen after seeing the result is another search.
- Check one alternative definition chosen in advance. If the ranking of regimes changes, the regime story depends on the definition; report it that way.
- Tail buckets are often small; a high average on a few dozen days can be a few large days.
- Nothing in the breakdown is selection-adjusted. Word titles and captions as observations.

## Multiple testing

With 20 independent tries at 5 %, at least one "significant" result is more likely than not (`1 − 0.95^20 ≈ 64 %`). Put every field you are comparing into one permutation call, and report fields tried elsewhere.
