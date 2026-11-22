---
name: dc-analysis
description: Double calendar health check and optimization. Analyzes a DC strategy's performance, exit attribution, VIX regime fit, S/L ratio impact, edge decay, and predictive fields. Loads the strategy profile for context. Use when evaluating, diagnosing, or tuning a double calendar backtest, or when the user mentions "DC analysis", "calendar analysis", or "analyze my DC".
compatibility: Requires TradeBlocks MCP server with trade data loaded
metadata:
  author: tradeblocks
  version: "1.0"
---

# Double Calendar Analysis

Comprehensive health check for double calendar strategies. Each DC responds differently to filters and exits depending on its DTE spread, delta selection, and underlying. This skill surfaces those differences.

## Prerequisites

- TradeBlocks MCP server running
- Block with DC trade data loaded
- Strategy profile recommended (will prompt to create if missing)
- Market data (SPX daily + VIX context) for regime analysis

## Process

### Step 1: Select Block and Load Profile

1. **Ask which DC to analyze.** Use `list_blocks` if needed.
2. **Check for a profile.** Call `get_strategy_profile` with the block and strategy name.
   - If profile exists: load it and summarize the structure (DTE spread, deltas, entry/exit rules, underlying).
   - If no profile: ask the user for the OO settings (screenshots work) and create one via `profile_strategy`. Key fields needed:
     - Underlying, DTE spread (short/long), put/call deltas
     - Entry filters (day, time, S/L ratio min, VIX, RSI)
     - Exit rules (profit target, time exit, S/L ratio exit, delta exits)
     - Position sizing (allocation %)

Display the profile summary before continuing:
```
Structure: [underlying] [short DTE]/[long DTE] DC, [put delta]/[call delta] delta
Entry: [day], [time], [filters]
Exits: [list exit rules]
Sizing: [allocation]%
```

### Step 2: Baseline Performance

Run `get_statistics` for the block.

Present the core metrics:

| Metric | Value | Context |
|--------|-------|---------|
| Win Rate | | >60% typical for DCs |
| Profit Factor | | >2.0 strong |
| Sharpe | | >3.0 strong for DCs |
| Max Drawdown | | <15% good |
| Avg Win / Avg Loss | | Payoff ratio |
| Trade Count | | <100 = thin data warning |

### Step 3: Exit Attribution

Run `get_performance_charts` with `charts: ["exit_reason_breakdown"]`.

This is critical for DCs. Build a table:

| Exit Type | Count | Avg P&L | Total P&L | Verdict |
|-----------|-------|---------|-----------|---------|
| Time exit | | | | Money maker or money loser? |
| S/L ratio | | | | Primary stop or profit engine? |
| Delta exit (above) | | | | How much damage? |
| Delta exit (below) | | | | How much damage? |
| Profit target | | | | Capturing enough? |
| Expired | | | | Good or bad for this DC? |

Key insight from DC research: Exit types play DIFFERENT roles depending on the DC structure.
- For some DCs (like SPX 8/10), S/L ratio exits are the **profit engine** — they catch winners early.
- For others (like QQQ 2/4), time exits are the money maker and delta exits cause all the damage.
- If time exits are big losers, the DC may need tighter management before expiry.

### Step 4: S/L Ratio Analysis

Run `find_predictive_fields` to check if `openingShortLongRatio` correlates with P&L.

**Interpretation guide based on DTE/delta:**
- **Short DTE + high delta (2/4 at 20Δ):** S/L ratio typically irrelevant (correlation ~0). Don't filter.
- **Mid DTE + mid delta (5/7 at 25Δ):** S/L ratio is the strongest predictor. Sweet spot typically 0.5-0.7.
- **Long DTE + lower delta (21/28 at 30Δ):** Weak but positive correlation. Some value in minimum threshold.

If the opening ratio correlation is > 0.05 and the ratio passes Step 8's timing check, run `filter_curve` on `openingShortLongRatio` to explore entry thresholds.

Also check `closingShortLongRatio` as a retrospective indicator of exit health, not an entry-filter input.

### Step 5: Structure Fit Analysis

If the strategy has a profile, run `analyze_structure_fit` with the block and strategy name. This provides a multi-dimensional breakdown of how well the strategy fits various market conditions, using the profile to contextualize results.

**Tool returns:**
- Performance by Vol_Regime, day-of-week, time-of-day
- Profile-derived dimension analysis (entry filters, DTE, deltas)
- `profile_update_hints` when data shows patterns diverging from profile settings
- Thin-data warnings for small buckets

Surface any `profile_update_hints` — these are actionable suggestions where the data contradicts the profile's assumptions.

If no profile exists, fall back to `analyze_regime_performance` with `segmentBy: "volRegime"` instead.

### Step 6: VIX Regime Performance

Run `analyze_regime_performance` with `segmentBy: "volRegime"`.

Build a regime table and flag the sweet spot vs danger zones:

| Regime | Trades | Win Rate | PF | Avg P&L | vs Overall |
|--------|--------|----------|-----|---------|------------|
| Very Low (<13) | | | | | |
| Low (13-16) | | | | | |
| Normal (16-20) | | | | | |
| Elevated (20-25) | | | | | |
| High (25-30) | | | | | |
| Extreme (>30) | | | | | |

**Interpretation guide:**
- Longer DTE DCs (9+) tend to thrive in Normal-Elevated VIX (more vega to harvest).
- Shorter DTE DCs may do better in low VIX (less gamma risk, cleaner theta decay).
- If a regime has <10 trades, flag as thin data.
- Compare to profile's `expectedRegimes` if set.

### Step 7: Edge Decay Check

Run `analyze_edge_decay` for the block.

Focus on:
1. **Yearly trends:** Is win rate, profit factor, or Sharpe declining?
2. **Recent vs historical:** Is the recent window diverging from full history?
3. **2026 YTD performance:** Has the strategy held up in the current environment?
4. **Worst consecutive losing months:** How bad does it get?

Flag any of these:
- Win rate slope < -3%/yr
- Profit factor slope < -0.5/yr
- Recent Sharpe < 50% of historical Sharpe
- Current streak is worst-ever losing streak

### Step 8: Predictive Fields Deep Dive

Use Step 4's `find_predictive_fields` results. A high rank measures association with P&L, not whether the value was available at entry. Exclude outcome fields such as `netPl`, `plPct`, `rom`, `isWinner`, `maxProfit`, and `maxLoss` from the candidate list.

**Entry-filter candidates:** Surface up to five fields with `|correlation| > 0.1` whose values could be observed or computed before the entry decision. Consider `openingShortLongRatio`, `openingVix`, and `gap` when the source measurement was already available at that decision. State the source and timing; if either is unknown, keep the field out of the candidate list. Recorded `premium` is entry-pricing context, not evidence that the fill price was knowable before entry. A pre-entry quote is a separate input and must be tested on its own. Use `numContracts` to investigate sizing effects, not as an entry signal.

**Retrospective diagnostics:** Report useful associations separately: `closingShortLongRatio` for exit health, `durationHours` for actual holding time, `movement` for realized underlying movement over the trade, `closingVix` for VIX at exit, and `vixChangePct` for the change from entry to exit. Never use these recorded values as entry conditions, regardless of their correlations. If one suggests an entry hypothesis, define a separate signal using only information known before entry and test it independently. Do not transfer the diagnostic's correlation or threshold to that signal.

### Step 9: Curve Fit Detection

Before making any recommendations, test whether the current setup is robust or overfit. Run these checks in order — each one builds on the previous.

#### 9a. Entry Filter Validation

Check existing profile filters against Step 8 before interpreting them. Flag any close-known or unverified filter as ineligible for entry. If the strategy has a profile with entry filters, run `validate_entry_filters` with the block and strategy name. Treat comparisons involving ineligible fields as retrospective only, not as evidence that an entry rule works.

**Tool returns:**
- Per-filter comparison: entered trades vs filtered-out trades (full stat suite for both groups)
- Ablation study: removes one filter at a time and tests all pairs
- `profile_update_hints` when filters appear counterproductive

**What to look for:**
- A filter is **helping** if entered trades outperform filtered-out trades on profit factor and win rate
- A filter is **hurting** if filtered-out trades actually perform better (the filter is excluding winners)
- The ablation study shows which filters interact — some only work in combination

Also run `suggest_filters` to see if there are market-based filters the data suggests but the profile doesn't use. This tool analyzes losing trades and suggests filters that would have improved performance. Pass `strategyName` to cross-reference suggestions against existing profile filters.

Apply the same timing check to `suggest_filters` results before considering them for entry. Sweep only entry-eligible inputs for entry thresholds.

#### 9b. Baseline Sanity Check

The strategy should be profitable WITHOUT entry filters. Use the `validate_entry_filters` ablation results to see what happens when all filters are removed.

Ask: "Is this strategy only profitable BECAUSE of the filters?" If removing all filters makes it a net loser, the filters are creating edge — that's curve fitting. Filters should IMPROVE an already-positive baseline, not rescue a broken structure.

#### 9c. Parameter Sensitivity (Adjacent Value Test)

Test small changes to numeric entry thresholds with `filter_curve` only for fields that pass Step 8's timing check. Test exit thresholds separately with `batch_exit_analysis`.

| What to test | How | Red flag |
|-------------|-----|----------|
| S/L ratio min (if used) | `filter_curve` on `openingShortLongRatio` | Good at 0.45 but bad at 0.40 and 0.50 |
| VIX filter (if used) | `filter_curve` on `openingVix` | Good at VIX<18 but bad at VIX<17 and VIX<19 |
| Delta exit threshold | Compare batch_exit_analysis at profile delta vs +/-5 | Good at 70 but bad at 65 and 75 |
| Profit target % | Compare batch_exit_analysis at profile PT vs +/-10% | Good at 50% but bad at 40% and 60% |

**Interpretation:**
- **Robust:** Performance degrades gradually as you move away from the chosen value. A plateau or wide sweet spot is ideal.
- **Overfit:** Sharp cliff at the exact chosen value. Performance is great at X but terrible at X+1 or X-1.

Present the filter_curve results as a table showing performance at each threshold step. Look for smooth gradients, not cliffs.

#### 9d. Walk-Forward OOS Check

From Step 7's edge decay data, extract the walk-forward efficiency ratios:

| Metric | Recent OOS Efficiency | Historical OOS Efficiency | Verdict |
|--------|----------------------|--------------------------|---------|
| Win Rate | | | >0.8 = holding up |
| Profit Factor | | | >0.8 = holding up |
| Sharpe | | | >0.5 = acceptable |

**Interpretation:**
- OOS efficiency > 1.0 = outperforming in-sample (unlikely to be overfit)
- OOS efficiency 0.7-1.0 = reasonable decay, probably genuine edge
- OOS efficiency < 0.5 = significant IS/OOS gap, possible overfitting
- OOS efficiency declining over time = edge may be decaying or original fit was to a specific regime

#### 9e. Year-over-Year Consistency

From Step 7's period metrics, check: does the strategy work in EVERY full year, or only some?

| Year | Win Rate | PF | Positive? |
|------|----------|-----|-----------|
| (each full year) | | | Yes/No |

**Interpretation:**
- Profitable in ALL full years = strong evidence of genuine edge
- Profitable in 3/4 years = acceptable, check if the bad year has an explanation (regime shift, etc.)
- Profitable in only 1-2 years = high curve fit risk — the "edge" may be a specific market period

#### 9f. Trade Count Check

After all filters are applied, how many trades per year remain?

| Threshold | Risk Level |
|-----------|-----------|
| 40+/year | Good sample size |
| 25-40/year | Acceptable for weekly DCs |
| 15-25/year | Getting thin — each trade matters too much |
| <15/year | Danger zone — statistical reliability is poor |

If filters cut more than 50% of trades, the question is: does the P&L per trade improve enough to justify the reduced sample?

#### 9g. Curve Fit Verdict

Summarize the findings. If an existing entry rule uses a close-known or unverified field, flag entry validation as failed and do not call the setup robust on the basis of its retrospective results.

| Check | Result | Flag |
|-------|--------|------|
| Entry filters validated? | | PASS/WARN/FAIL |
| Baseline profitable without filters? | | PASS/WARN/FAIL |
| Parameter sensitivity smooth? | | PASS/WARN/FAIL |
| Walk-forward OOS efficiency > 0.7? | | PASS/WARN/FAIL |
| Profitable in all full years? | | PASS/WARN/FAIL |
| Trade count adequate (>25/yr)? | | PASS/WARN/FAIL |

- **5 PASS:** Strong confidence the strategy is robust
- **4 PASS, 1 WARN:** Likely robust, monitor the warning
- **3 or fewer PASS:** Curve fit risk is significant — recommend simplifying filters
- **Any FAIL on baseline:** The structure itself may not have edge — filters are papering over a broken thesis

### Step 10: Synthesis and Recommendations

Bring it all together. Answer these questions:

1. **Is this DC healthy?** Sharpe, win rate, profit factor trends
2. **What's driving profits?** Which exit type makes the money?
3. **What's causing losses?** Which exit type or regime is the biggest drag?
4. **Is the edge decaying?** Yearly trends and recent performance
5. **Is it overfit?** Curve fit verdict from Step 9
6. **What would you change?** Based on the data:
   - Add/remove entry filters?
   - Adjust exit thresholds?
   - Change position sizing for specific regimes?
   - Consider pausing in certain VIX environments?

Keep retrospective explanations separate from proposed entry changes, including any recommendation to pause in a VIX regime. Use only entry-eligible signals from Steps 8–9 for entry recommendations.

**DO NOT recommend specific threshold values without supporting data.** If S/L ratio correlation is 0.001, don't suggest an S/L ratio filter. Let the data speak.

**Reference the DC workshop learnings:**
- "Adding little bits at a time" — don't stack filters, test one at a time
- Each filter should have explanatory power — you should know WHY it works
- If removing a filter doesn't hurt much, the filter may be noise
- If 27% threshold works but 30% doesn't, that's curve fitting territory

## Optional: Exit Simulation (when replay data available)

If the user wants to test exit rule changes, use `batch_exit_analysis` with the profile's exit rules translated to trigger configs:

| Profile Exit Rule | Trigger Config |
|-------------------|----------------|
| Profit target 50% | `{"type": "profitTarget", "threshold": 0.5, "unit": "percent"}` |
| S/L ratio below 0.3 | `{"type": "slRatioThreshold", "threshold": 0.3, "exitBelow": 0.3}` |
| Sell Put delta > 70 | `{"type": "perLegDelta", "threshold": 0, "legIndex": 0, "exitAbove": 0.70}` |
| Sell Call delta < -70 | `{"type": "perLegDelta", "threshold": 0, "legIndex": 1, "exitBelow": -0.70}` |
| S/L ratio move -100% | `{"type": "slRatioMove", "threshold": 1.0}` |
| Clock time exit | `{"type": "clockTimeExit", "threshold": 0, "clockTime": "14:45"}` |

**Note:** Delta thresholds use decimal format (0.70, not 70). OO uses whole numbers.

## Reference

- For DC mechanics, term structure, curve fitting principles, and common failure modes, see [references/dc-mechanics.md](references/dc-mechanics.md)

## What NOT to Do

- Don't assume S/L ratio filtering works for all DCs — test it first
- Don't stack VIX + S/L ratio + VIX9D/VIX filters — they're often correlated, pick one
- Don't recommend delta exit thresholds without testing adjacent values (65 vs 70 vs 75)
- Don't present a single "optimal" configuration — show the tradeoffs
- Don't ignore thin data warnings — 10 trades in a bucket is suggestive, not conclusive
