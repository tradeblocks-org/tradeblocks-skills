# VRP definitions

Contents: [Implied volatility](#implied-volatility-iv) | [Realized volatility](#realized-volatility-rv) | [VRP](#vrp) | [Timing](#timing) | [Model-free columns (v2)](#model-free-columns-v2) | [Variance form](#variance-form---sum-var) | [Centre and return frequency](#centre-and-return-frequency---center---rv-freq) | [Moment premia](#moment-premia---moments) | [Leg VRP](#leg-vrp---leg) | [Range RV](#range-rv---range-rv) | [Log form](#log-form---ln) | [Multi mode and weighting](#multi-mode-and-weighting) | [Timing of the optional columns](#timing-of-the-optional-columns)

All values are annualized volatilities in percent (vol points). IV and RV use the same window and the same time basis, so their difference is meaningful.

## Implied volatility (`iv`)

Black-Scholes implied vol of the straddle premium (put + call at the same strike) at entry:

- Time to expiry `T = minutes from entry to 16:00 / 390 / 252` (trading-time basis).
- Spot = the trade's opening underlying price; strike from the legs.
- Rate `r` = 4.5 % by default (forward drift). For 0DTE its effect is below 0.01 vol points at the money and about 0.06 when the strike is 10 points from spot. Dividends are ignored.
- Solved by bisection between 0.01 % and 500 %; a premium outside that range yields no value for the day.

Premiums from a backtest follow its fill model, so IV blocks must run with slippage 0 and commission 0: Option Omega then fills at the bid-ask mid, the same price definition as the literature (e.g. Almeida, Freire & Hizmeri use the bid-ask midpoint). Any slippage would bias `iv` upward for long legs and downward for short legs.

## Realized volatility (`rv`)

Standard deviation of 1-minute log returns of the underlying from the entry bar to 16:00, annualized with `sqrt(390 * 252)`.

- The window starts at entry, not at the open: the opening minutes carry much variance that the straddle never sees.
- `rv_5m` uses 5-minute closes aligned to the entry minute, annualized with `sqrt(78 * 252)`; it is less affected by microstructure noise.
- Days with less than 80 % of the expected bars, or without a bar at the entry minute, are skipped.

## VRP

`vrp = iv - rv`, and `vrp_5m = iv - rv_5m`. Positive values mean the straddle was priced above the volatility that followed.

## Timing

`iv` is known at the entry time. `rv` and `vrp` are known only after the close, so as filters they can only be used from the next day (import them with `close` timing). A live filter on today's VRP needs a forecast of `rv`, which this skill does not provide.

## Model-free columns (v2)

All on the trading-time basis `T = minutes to 16:00 / 390 / 252`, r = q = 0 (forward = spot).

### Nodes and smile

- Nodes: OTM puts (K < spot), OTM calls (K > spot) and the ATM node (mean of the put and call IV at the straddle strike). Each IV is the Black-Scholes IV of the option price, `x = ln(K / spot) / sqrt(T)`. At least 4 put and 4 call nodes are needed, else the day is skipped and reported by the preflight.
- Smile: PCHIP in `x` through the node IVs (monotone between nodes, no overshoot).
- Wings (`--wings`): `flat` (default) holds the outermost node IV out to `x = max(10 * sigma_edge, |x_edge| + 1)`; `trunc` integrates only between the outermost nodes (lower bound); `slope` continues the outermost segment's slope (IV clipped to 2 % .. 300 %; upper bound). The order is trunc < flat < slope. The spread shows how much the unobserved far wings matter.

### Implied semivariance

`down = (2 / T) * integral_{K < spot} P(K) / K^2 dK`, `up = (2 / T) * integral_{K > spot} C(K) / K^2 dK`, `total = down + up`, evaluated numerically on a 0.5-point strike grid (trapezoid). With a flat smile `total = sigma^2`; down and up are then the lognormal semivariances (down > up, because the drift is -sigma^2 / 2). `iv_down`, `iv_up`, `iv_mf` are `100 * sqrt(.)` of these.

`iv_mf` is usually above the ATM `iv` (skew and wings add variance). On flat or inverted smiles, mostly high-vol days, it can be slightly below (SPX 09:45, 2022-06..2026-10: 56 of 1085 days, median 0.11 vol points); that is the smile, not an error.

### Realized semivariance

From 5-minute log returns `r` between the entry bar and 16:00 (aligned to the entry minute, as `rv_5m`): `down = sum(r^2 for r < 0) / T`, `up = sum(r^2 for r > 0) / T` (no factor 2), `total = down + up`. `rv_down`, `rv_up` are `100 * sqrt(.)`. For an entry minute that is not a multiple of 5 minutes before 16:00 the last return ends before 16:00 while T still counts to 16:00.

### VRP

`vrp_down = iv_down - rv_down`, `vrp_up = iv_up - rv_up`, `vrp_mf = iv_mf - sqrt(rv_down^2 + rv_up^2)`, all in vol points (differences of square roots). **Down and up add in variance, not in vol points**: `iv_mf^2 = iv_down^2 + iv_up^2`, but `vrp_mf != vrp_down + vrp_up`.

### Sources

- `iv_source = quotes`: mid of bid and ask from `market.option_quote_minutes` at the entry minute, 0DTE contracts only, OTM only. Walking outward from spot, the first strike with a zero bid and every strike beyond it are dropped (CBOE rule). Spot is the entry bar's open.
- `iv_source = oo`: fills of the Option Omega strangle and straddle trades at the entry time, one node per leg; identical strikes from several blocks are averaged; spot is the median `Opening Price`. Backtest fills include its fill model, and far-OTM legs fill at the minimum tick (0.05), which flattens the far wings: `mintick_nodes` counts these. With quotes in TradeBlocks the quotes path is preferred.
- `--trades db` reads the same legs with SQL from `trades.trade_data`; the table lacks `Opening Price`, so the spot is the entry-bar open (rounded to 0.01). On the 09:45 data 12 of 1085 days then differ in spot by 0.01 to 1.1 points (max effect: `iv` 0.017, `iv_mf` 0.007, `iv_down` 0.15 vol points); the default `--trades csv` reproduces the trade-log spot exactly.
- `n_put_nodes`, `n_call_nodes`: OTM nodes used (the ATM node not counted).

### Timing

`iv`, `iv_down`, `iv_up`, `iv_mf` are known at the entry time (`open`, `knownBy` = entry). All `rv*` and `vrp*` are known only after the close (`close`).

## Variance form (`--sum-var`)

Same quantities as the model-free columns, in variance units (annualized, not percent, not square-rooted), `T` and sources as above:
`iv_down_var`, `iv_up_var` (implied semivariances), `rv_down_var`, `rv_up_var` (realized semivariances), `vrp_down_var = iv_down_var - rv_down_var`, `vrp_up_var = iv_up_var - rv_up_var`,
`vrp_sum_var = vrp_down_var + vrp_up_var = (iv_down^2 - rv_down^2) + (iv_up^2 - rv_up^2)` with the vol-point columns divided by 100. Unit: variance (0.01 = 10 vol points squared).

## Centre and return frequency (`--center`, `--rv-freq`)

- `--center spot` (default): smile and integrals centred on the entry-bar open (or the OO `Opening Price`), cleaning as under Sources.
- `--center forward` (quotes only): centre = put-call parity forward `F = K + C - P` at the strike with the smallest `|C - P|` among strikes with both bids > 0 (mids). Quote cleaning: bids of 0 are dropped, and walking outward from the centre everything beyond two consecutive zero bids; ask >= bid required. The smile node at the centre strike is the mean of the put and call IV. `x = ln(K / F) / sqrt(T)`. The v1 columns (`spot`, `strike`, `put`, `call`, `straddle`, `iv`) then use the parity strike and the entry-bar open. Not available for OO blocks.
- `--rv-freq 5m` (default): `rv_down`, `rv_up` from 5-minute returns as above. `1m`: from 1-minute log returns entry -> 16:00 (`sum r^2 / T`), needs a complete 1-minute path; days with a gap get no value. The same frequency is used for `p_*` (moments). `rv` and `rv_5m` keep their own definitions.

## Moment premia (`--moments`)

Bakshi-Kapadia-Madan moments of the log return to 16:00, `r = q = 0`, `T` as above.

- Q (from the smile): with `V`, `W`, `X` the BKM integrals of the OTM option values (weights `2(1 - ln(K/S))/K^2`, `6 ln(K/S) - 3 ln(K/S)^2` over `K^2`, `12 ln(K/S)^2 - 4 ln(K/S)^3` over `K^2`; `S` = centre), `mu = -V/2 - W/6 - X/24`, `var = V - mu^2`, `skew = (W - 3 mu V + 2 mu^3) / var^1.5`, `kurt = (X - 4 mu W + 6 mu^2 V - 3 mu^4) / var^2` (raw kurtosis, 3 = Gaussian). `q_var = var / T` (annualized variance), `q_skew`, `q_kurt` dimensionless.
- Only smile nodes with `|x / sigma_atm| <= 4` are used (sigma_atm = smile at `x = 0`, linear interpolation), at least 4 nodes, wings truncated at the outermost used node (independent of `--wings`).
- P (realized): from the 1-minute (`--rv-freq 1m`) or 5-minute path entry -> 16:00 with `y` = cumulative log return before step `i`, `h = e^r - 1 - r`: `M2 = sum(r^2 - 2 y h)`, `M3 = sum(-3 y^2 h + 3 y r^2 + r^3)`, `M4 = sum(-4 y^3 h + 6 y^2 r^2 + 4 y r^3 + r^4)`; these take the place of `V`, `W`, `X`. `p_var = var / T`, `p_skew`, `p_kurt` as for Q.
- `varp = q_var - p_var` (variance units), `skewp = q_skew - p_skew`, `kurtp = q_kurt - p_kurt` (differences of dimensionless numbers).

## Leg VRP (`--leg`)

Quotes only; always on the forward chain (`--center forward` cleaning), needs a complete 1-minute path and uses 1-minute realized variance of the day.

- Strikes: the put and the call whose Black-Scholes delta (IV from the mid, centre = forward) is closest to 16 (absolute), within 25 % of it; `leg_kp`, `leg_kc` (index points).
- Q price of each leg: Gram-Charlier (Corrado-Su) option value with parameters (sigma, skew, raw kurtosis) fitted by least squares with equal price weights to the OTM mids in the band `[kp - 100, kc + 100]` plus the OTM-side quote of the parity strike (at least 8 points; fit bounds sigma 0.01..3, skew -3..3, kurtosis 1..60; two starts; fit must converge).
- P price: same formula with mean 0 and the trailing P world: sessions strictly before the day with the same entry minute, window 250, at least 120 sessions: `kappa = sqrt(mean(r^2 / rv))` (`r` = log return entry -> 16:00, `rv` = sum of squared 1-minute returns), `z = r / (kappa sqrt(rv))`, skew and kurtosis of `z`, sigma = `kappa sqrt(rv_t / T)` with `rv_t` the day's own 1-minute sum of squares.
- `leg_put = V_Q - V_P` of the put, `leg_call` of the call, `leg_vrp = leg_put + leg_call`. Unit: index points per contract unit (multiply by 100 for USD per contract). Missing in the first 120 sessions of complete data.

## Range RV (`--range-rv`)

`rv_range = 100 * sqrt( sum(ln(high / low)^2) / (4 ln 2) / T )` over the 1-minute bars after the entry bar to 16:00 (Parkinson), vol points; needs a complete path. `vrp_range = iv - rv_range`.

## Log form (`--ln`)

`lnvrp = ln(iv^2 / rv^2)`, `lnvrp_5m = ln(iv^2 / rv_5m^2)`, `lnvrp_range = ln(iv^2 / rv_range^2)` for the ATM straddle IV; dimensionless, equal to `2 ln(iv / rv)`. Missing where `iv` or the realized value is missing.

## Multi mode and weighting

- `--mode multi`: the 26 entries 09:32, 09:45, 10:00 ... 15:45 (every 15 minutes, plus 09:32) of each session, each with its own `T`. Quotes only (no OO blocks). An entry is valid with an entry bar, at least 80 % of the bars to 16:00, bars beyond 13:05 (half-days therefore give no row), usable quotes (at least 4 put and 4 call nodes). Entry columns use the definitions above.
- Daily value of a column = aggregate over the entries with a finite value, only if there are at least 20 of them, else the column is empty. Aggregated: every numeric column except `spot`, `strike`, `put`, `call`, `straddle`, `leg_kp`, `leg_kc` and the metadata. `n_entries` = valid entries of the day, `weight` = weighting used.
- `--weight tau`: weights proportional to the minutes to 16:00 (`sum(w x) / sum(w)`). `--weight equal`: plain mean. One setting applies to all columns of a run.
- `--per-entry FILE` writes the entry rows (no aggregation).

## Timing of the optional columns

Single mode: columns that use only the smile at entry (`iv*`, `iv_*_var`, `q_var`, `q_skew`, `q_kurt`) are `open` with `knownBy` = entry time. Everything that uses a realized quantity (`rv*`, `vrp*`, `p_*`, `varp`, `skewp`, `kurtp`, `leg_*`, `rv_range`, `lnvrp*`, `vrp_*_var`, `vrp_sum_var`, `rv_*_var`) is `close`. Multi mode: all columns `close` (the daily value uses entries up to 15:45). The script prints the plan as a `timing:` line when `--dataset` is written.

## Limits

- Q moments and legs depend on the far-OTM quotes; the +-4 SD cap and trunc wings make them lower-bound style estimates at wide smiles.
- Realized moments from a single 0DTE path are one draw; there is no dispersion measure in the output.
- Leg VRP needs about 120 sessions of history per entry minute and a converged fit; days without are empty.
