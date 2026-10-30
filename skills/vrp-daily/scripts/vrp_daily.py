#!/usr/bin/env python3
"""vrp_daily: per-day implied vol (IV), realized vol (RV) and volatility risk premium (VRP) at a
fixed entry time, from a 0DTE ATM straddle (v1 columns) and from the whole smile (model-free
down / up / total, v2 columns).

v1 columns (unchanged)
  IV  = Black-Scholes implied vol of the straddle premium at entry (same-strike put + call),
        T = minutes from entry to 16:00 / 390 / 252 (trading-time basis), r constant, q = 0.
  RV  = realized vol of the underlying's 1-minute closes from the entry bar to 16:00,
        std(log returns) * sqrt(390 * 252). rv_5m: the same on 5-minute closes, * sqrt(78 * 252).
  VRP = IV - RV, in vol points.
v2 columns (model-free, trading-time T, r = q = 0)
  iv_down / iv_up / iv_mf = 100 * sqrt of the implied semivariance below / above spot / total,
      (2/T) * integral of OTM option value / K^2 over the strike range, smile interpolated with PCHIP.
  rv_down / rv_up = 100 * sqrt of the realized semivariance of 5-minute log returns entry -> 16:00.
  vrp_down / vrp_up / vrp_mf = iv_x - rv_x in vol points. Down + up add in variance, not in vol points.

Optional columns (version 2.1; defaults and the columns above are unchanged; details in references/definitions.md)
  --sum-var     iv/rv/vrp down and up in variance units and vrp_sum_var = (iv_down^2-rv_down^2)+(iv_up^2-rv_up^2).
  --moments     q_var/q_skew/q_kurt (BKM from the smile, nodes within +-4 ATM SD), p_var/p_skew/p_kurt (realized),
                varp, skewp, kurtp (Q minus P; raw kurtosis).
  --leg         V1 leg VRP at the 16-delta strikes (Gram-Charlier Q vs trailing P; quotes only, forward chain).
  --range-rv    rv_range (Parkinson, 1-minute high/low) and vrp_range.      --ln  lnvrp = ln(IV^2/RV^2).
  --center spot|forward   centre of smile and integrals; --rv-freq 5m|1m   return frequency of rv_down/up and p_*.
  --mode multi --weight tau|equal   26 entries 09:32 .. 15:45 per day, daily aggregate of every column over the
                entries (needs >= 20 valid entries per column); --per-entry FILE writes the single entries.
  The script computes what is asked; choosing variant, mode, entry time and weighting is the user's decision.

IV sources (the script never fetches data):
  quotes  market.option_quote_minutes in market.duckdb: 0DTE contracts at the entry minute.
  oo      TradeBlocks blocks / trade logs of 0DTE strangles and an ATM straddle at the entry time
          (--block ID, repeatable, read from <data-dir>/<ID>/tradelog.csv; or --tradelog FILE, repeatable).
  Quotes are used for a day if they give >= 4 put and >= 4 call OTM nodes, else the OO blocks.

Inputs (read-only): --market-db (market.duckdb of the TradeBlocks data directory, tables market.spot
  and optionally market.option_quote_minutes), --block / --tradelog.
Outputs: --out full CSV (one row per day), --dataset CSV for import_daily_dataset.

Modes:
  --check        preflight only: per day SPX minute bars and IV source; prints a summary and the list
                 of missing items, each naming the skill that provides them (--json: machine-readable).
  (compute)      runs the preflight first; with gaps it exits 3 unless --allow-gaps (skips and lists
                 the incomplete days).

Requires python3, numpy, scipy and duckdb (pip install numpy scipy duckdb).
Exit codes: 0 ok, 2 missing or unusable input, 3 preflight found gaps (nothing computed).
"""
import argparse
import csv
import json
import math
import os
import re
import sys
import time
from datetime import datetime

try:
    import numpy as np
    from scipy.interpolate import PchipInterpolator
    from scipy.optimize import least_squares
    from scipy.special import ndtr
except ImportError:
    print("error: numpy and scipy are required: pip install numpy scipy", file=sys.stderr)
    sys.exit(2)

MINUTES_PER_DAY = 390
TRADING_DAYS = 252
V1_FIELDS = ["date", "entry_time", "spot", "strike", "put", "call", "straddle", "t_minutes",
             "iv", "rv", "vrp", "rv_5m", "vrp_5m", "n_bars"]
V2_FIELDS = ["iv_down", "iv_up", "iv_mf", "rv_down", "rv_up", "vrp_down", "vrp_up", "vrp_mf",
             "n_put_nodes", "n_call_nodes", "mintick_nodes", "iv_source"]
FIELDS = V1_FIELDS + V2_FIELDS
DATASET_FIELDS = ["date", "iv", "rv", "vrp", "rv_5m", "vrp_5m",
                  "iv_down", "iv_up", "iv_mf", "rv_down", "rv_up", "vrp_down", "vrp_up", "vrp_mf"]
# optional columns, appended after the v1/v2 columns only when the flag is given (argparse dest -> columns)
EXTRA_FIELDS = {
    "sum_var": ["iv_down_var", "iv_up_var", "rv_down_var", "rv_up_var", "vrp_down_var", "vrp_up_var", "vrp_sum_var"],
    "moments": ["q_var", "q_skew", "q_kurt", "p_var", "p_skew", "p_kurt", "varp", "skewp", "kurtp"],
    "leg": ["leg_kp", "leg_kc", "leg_put", "leg_call", "leg_vrp"],
    "range_rv": ["rv_range", "vrp_range"],
    "ln": ["lnvrp", "lnvrp_5m", "lnvrp_range"],
}
NOT_IN_DATASET = {"leg_kp", "leg_kc"}                 # strikes are metadata, not series
# dataset columns known at the entry time (knownBy = entry, timing open); every other column is timing close
OPEN_COLUMNS = {"iv", "iv_down", "iv_up", "iv_mf", "iv_down_var", "iv_up_var", "q_var", "q_skew", "q_kurt"}
MULTI_ENTRIES = ["09:32", "09:45"] + [f"{h:02d}:{m:02d}" for h in range(10, 16) for m in (0, 15, 30, 45)]
MULTI_MIN_VALID = 20     # valid entries per column needed for a daily multi aggregate
K_STD = 4.0              # BKM nodes kept: |x / sigma_atm| <= K_STD
LEG_DELTA, LEG_TOL, LEG_WING = 16, 0.25, 100.0
LEG_WIN, LEG_MIN_HIST = 250, 120
MIN_NODES = 4            # OTM nodes needed per side
MIN_BAR_SHARE = 0.8
MINTICK = 0.05
STEP = 0.5               # strike grid spacing (index points) of the numerical integral
IV_LO, IV_HI = 0.02, 3.0
WINGS = ("trunc", "flat", "slope")
QUOTE_COLS = {"underlying", "ticker", "date", "time", "bid", "ask"}
OCC_RE = re.compile(r"^([A-Z]+)(\d{6})([CP])(\d{8})$")
EXIT_GAPS = 3
LEG_RE = re.compile(r"(\d+)\s+\w+\s+\d+\s+([\d.]+)\s+([PC])\s+(STO|BTO)\s+([\d.]+)")


def fail(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(2)


def ncdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def bs_straddle(s, k, t, r, sigma):
    """Black-Scholes value of a same-strike call + put."""
    if t <= 0 or sigma <= 0:
        return abs(s - k)
    st = sigma * math.sqrt(t)
    d1 = (math.log(s / k) + (r + 0.5 * sigma * sigma) * t) / st
    d2 = d1 - st
    df = math.exp(-r * t)
    return (s * ncdf(d1) - k * df * ncdf(d2)) + (k * df * ncdf(-d2) - s * ncdf(-d1))


def implied_vol(price, s, k, t, r):
    """Bisection on [0.01 %, 500 %]; None if the price is outside that range."""
    lo, hi = 1e-4, 5.0
    if not (bs_straddle(s, k, t, r, lo) <= price <= bs_straddle(s, k, t, r, hi)):
        return None
    for _ in range(100):
        mid = 0.5 * (lo + hi)
        if bs_straddle(s, k, t, r, mid) > price:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


def parse_legs(legs):
    """'1 Jun 1 4150 P STO 17.60 | 1 Jun 1 4150 C STO 19.70' -> (strike, put, call), else None."""
    put = call = kp = kc = None
    for part in legs.split("|"):
        m = LEG_RE.search(part.strip())
        if not m:
            continue
        k, side, price = float(m.group(2)), m.group(3), float(m.group(5))
        if side == "P":
            put, kp = price, k
        else:
            call, kc = price, k
    if put is None or call is None or kp != kc:
        return None
    return kp, put, call


def realized_vol(closes, bars_per_day):
    rets = [math.log(b / a) for a, b in zip(closes, closes[1:]) if a > 0 and b > 0]
    if len(rets) < 2:
        return None
    mean = sum(rets) / len(rets)
    var = sum((x - mean) ** 2 for x in rets) / len(rets)
    return math.sqrt(var) * math.sqrt(bars_per_day * TRADING_DAYS)


def read_trades(path, entry, date_from, date_to):
    if not os.path.exists(path):
        fail(f"trade log not found: {path}")
    trades, other_times = [], set()
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        need = {"Date Opened", "Time Opened", "Opening Price", "Legs"}
        if not need.issubset(reader.fieldnames or []):
            fail(f"trade log lacks columns {sorted(need - set(reader.fieldnames or []))}")
        for r in reader:
            d, tm = r["Date Opened"], r["Time Opened"][:5]
            if tm != entry:
                other_times.add(tm)
                continue
            if (date_from and d < date_from) or (date_to and d > date_to):
                continue
            legs = parse_legs(r["Legs"])
            if legs:
                trades.append((d, float(r["Opening Price"]), *legs))
    if not trades:
        hint = f"; entry times in the log: {sorted(other_times)[:10]}" if other_times else ""
        fail(f"no straddle trades at {entry} in {path}{hint}")
    return trades


def open_market(path, underlying):
    try:
        import duckdb
    except ImportError:
        fail("duckdb is not installed: pip install duckdb")
    if not os.path.exists(path):
        fail(f"market database not found: {path}")
    for attempt in range(5):                      # TradeBlocks may hold the file briefly; retry on a lock
        try:
            con = duckdb.connect(path, read_only=True)
            break
        except duckdb.IOException as e:
            if attempt == 4:
                fail(f"cannot open {path} read-only: {e}")
            time.sleep(2)
    try:
        cols = {d[0] for d in con.execute("SELECT * FROM market.spot LIMIT 0").description}
    except duckdb.Error:
        cols = set()
    if not {"ticker", "date", "time", "close"}.issubset(cols):
        fail("market.spot with columns ticker, date, time, close not found; "
             "this TradeBlocks version stores minute bars differently")
    n = con.execute("SELECT COUNT(*) FROM market.spot WHERE ticker=?", [underlying]).fetchone()[0]
    if n == 0:
        fail(f"no {underlying} minute bars in market.spot; load them with TradeBlocks fetch_bars")
    return con




# ---------------------------------------------------------------- model-free core (no I/O)

def bs_otm(s, k, sigma, t, put):
    """OTM option value (put for K<S, call for K>S), r = q = 0; arrays allowed."""
    st = sigma * np.sqrt(t)
    d1 = (np.log(s / k) + 0.5 * st ** 2) / st
    d2 = d1 - st
    pv = k * ndtr(-d2) - s * ndtr(-d1)
    cv = s * ndtr(d1) - k * ndtr(d2)
    return np.where(put, pv, cv)


def iv_from_price(price, s, k, t, put):
    """Black-Scholes IV (r = 0) of a single option by bisection on [0.01 %, 500 %]; None if impossible."""
    if price is None or not price > 0 or t <= 0:
        return None
    lo, hi = 1e-4, 5.0
    if not (float(bs_otm(s, k, lo, t, put)) <= price <= float(bs_otm(s, k, hi, t, put))):
        return None
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if float(bs_otm(s, k, mid, t, put)) > price:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


def _iv_fn(xn, vn, wings):
    pch = PchipInterpolator(xn, vn, extrapolate=False)
    lo_slope = (vn[1] - vn[0]) / (xn[1] - xn[0])
    hi_slope = (vn[-1] - vn[-2]) / (xn[-1] - xn[-2])

    def f(x):
        x = np.asarray(x, float)
        out = pch(np.clip(x, xn[0], xn[-1]))
        if wings == "slope":
            out = np.where(x < xn[0], vn[0] + lo_slope * (x - xn[0]), out)
            out = np.where(x > xn[-1], vn[-1] + hi_slope * (x - xn[-1]), out)
            out = np.clip(out, IV_LO, IV_HI)
        return out
    return f


def implied_semivariance(xn, vn, s, t, wings="flat", step=STEP):
    """Model-free implied semivariance. xn: increasing x = ln(K/S)/sqrt(T) of the nodes, vn: IV (decimal).
    down = (2/T) int_{K<S} P/K^2 dK, up = (2/T) int_{K>S} C/K^2 dK (trapezoid on a strike grid,
    PCHIP smile). wings: trunc (outermost nodes only), flat (IV of the outermost node out to
    max(10*sigma_edge, |x_edge|+1)), slope (linear continuation, IV clipped to [0.02, 3]).
    Returns dict down, up, total in variance units on the same T basis as t."""
    if wings not in WINGS:
        raise ValueError(f"wings must be one of {WINGS}")
    xn = np.asarray(xn, float)
    vn = np.asarray(vn, float)
    f = _iv_fn(xn, vn, wings)
    sq = math.sqrt(t)
    if wings == "trunc":
        x_lo, x_hi = xn[0], xn[-1]
    else:
        x_lo = -max(10.0 * vn[0], abs(xn[0]) + 1.0)
        x_hi = max(10.0 * vn[-1], abs(xn[-1]) + 1.0)
    res = {}
    for side, put in (("down", True), ("up", False)):
        k0, k1 = (s * math.exp(x_lo * sq), s) if put else (s, s * math.exp(x_hi * sq))
        n = max(int(math.ceil((k1 - k0) / step)), 2)
        k = np.linspace(k0, k1, n + 1)
        sig = f(np.log(k / s) / sq)
        g = bs_otm(s, k, sig, t, put) / k ** 2
        w = np.full(len(k), k[1] - k[0])
        w[0] = w[-1] = w[0] / 2
        res[side] = float((g * w).sum() * 2.0 / t)
    res["total"] = res["down"] + res["up"]
    return res


def realized_semivariance(rets, t):
    """rets: log returns entry -> close, t: years on the trading-time basis.
    down = sum r^2[r<0] / T, up = sum r^2[r>0] / T (no factor 2); total = down + up."""
    r = np.asarray(rets, float)
    return {"down": float((r[r < 0] ** 2).sum() / t), "up": float((r[r > 0] ** 2).sum() / t),
            "total": float((r ** 2).sum() / t)}


def iv_from_price_vec(price, s, k, t, put):
    """Array version of iv_from_price (same bisection, 80 steps on [0.01 %, 500 %]); NaN where impossible."""
    price = np.asarray(price, float)
    k = np.asarray(k, float)
    put = np.broadcast_to(np.asarray(put), price.shape)
    lo = np.full(price.shape, 1e-4)
    hi = np.full(price.shape, 5.0)
    ok = (price > 0) & (bs_otm(s, k, lo, t, put) <= price) & (price <= bs_otm(s, k, hi, t, put))
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        gt = bs_otm(s, k, mid, t, put) > price
        hi = np.where(gt, mid, hi)
        lo = np.where(gt, lo, mid)
    return np.where(ok, 0.5 * (lo + hi), np.nan)


def build_nodes(s, t, atm, puts, calls):
    """Smile nodes from an ATM straddle and OTM prices (vectorised IV inversion).
    atm: (K, put_price, call_price) or None; puts / calls: {strike: price}, only K<S / K>S are used.
    Returns (xn, vn, n_put, n_call, n_mintick) or None when fewer than MIN_NODES per side."""
    sq = math.sqrt(t)
    nodes, n_put, n_call, n_min = {}, 0, 0, 0
    xa = None
    if atm is not None:
        k, pp, cp = atm
        ivs = iv_from_price_vec(np.array([pp, cp], float), s, np.array([k, k], float), t, np.array([True, False]))
        ivs = ivs[np.isfinite(ivs)]
        if len(ivs):
            xa = math.log(k / s) / sq
            nodes[xa] = float(ivs.sum() / len(ivs))
    lo_cut = min(xa, 0.0) if xa is not None else 0.0
    hi_cut = max(xa, 0.0) if xa is not None else 0.0
    for book, put in ((puts, True), (calls, False)):
        if not book:
            continue
        ks = np.array(list(book.keys()), float)
        ps = np.array(list(book.values()), float)
        keep = (ks < s) if put else (ks > s)
        ks, ps = ks[keep], ps[keep]
        x = np.log(ks / s) / sq
        keep = (x < lo_cut) if put else (x > hi_cut)
        ks, ps, x = ks[keep], ps[keep], x[keep]
        v = iv_from_price_vec(ps, s, ks, t, put)
        g = np.isfinite(v)
        for xi, vi in zip(x[g], v[g]):
            nodes[float(xi)] = float(vi)
        n_min += int((ps[g] <= MINTICK + 1e-9).sum())
        if put:
            n_put += int(g.sum())
        else:
            n_call += int(g.sum())
    if n_put < MIN_NODES or n_call < MIN_NODES:
        return None
    xs = sorted(nodes)
    return xs, [nodes[x] for x in xs], n_put, n_call, n_min


def cboe_filter(book, put, s):
    """book: {strike: (bid, ask)} -> {strike: mid}. OTM only; walking outward from spot, the first
    strike with a zero bid and everything beyond it is dropped (CBOE rule)."""
    side = sorted((k for k in book if (k < s if put else k > s)), reverse=put)
    out = {}
    for k in side:
        bid, ask = book[k]
        if bid is None or ask is None or not bid > 0 or ask < bid:
            break
        out[k] = 0.5 * (bid + ask)
    return out


# ---------------------------------------------------------------- inputs

def parse_all_legs(legs):
    """All legs of a trade: [(strike, 'P'|'C', price)]."""
    out = []
    for part in legs.split("|"):
        m = LEG_RE.search(part.strip())
        if m:
            out.append((float(m.group(2)), m.group(3), float(m.group(5))))
    return out


def resolve_tradelogs(blocks, tradelogs, data_dir):
    paths = list(tradelogs or [])
    for b in blocks or []:
        p = os.path.join(data_dir, b, "tradelog.csv")
        if not os.path.exists(p):
            fail(f"block {b}: {p} not found (is --data-dir / the market.duckdb folder the TradeBlocks data directory?)")
        paths.append(p)
    return paths


def read_oo(paths, entry, date_from, date_to):
    """Reads trade logs. Returns (days, all_dates): days[date] = {'spot', 'atm', 'puts', 'calls'}
    for trades opened at the entry time (identical strikes from several logs: mean price);
    all_dates = every date with a trade at any time (defines the covered period)."""
    acc, all_dates = {}, set()
    for path in paths:
        if not os.path.exists(path):
            fail(f"trade log not found: {path}")
        with open(path, newline="", encoding="utf-8-sig") as fh:
            reader = csv.DictReader(fh)
            need = {"Date Opened", "Time Opened", "Opening Price", "Legs"}
            if not need.issubset(reader.fieldnames or []):
                fail(f"trade log {path} lacks columns {sorted(need - set(reader.fieldnames or []))}")
            for r in reader:
                d = r["Date Opened"]
                if (date_from and d < date_from) or (date_to and d > date_to):
                    continue
                all_dates.add(d)
                if r["Time Opened"][:5] != entry:
                    continue
                day = acc.setdefault(d, {"spots": [], "atm": [], "P": {}, "C": {}})
                try:
                    day["spots"].append(float(r["Opening Price"]))
                except ValueError:
                    continue
                legs = parse_all_legs(r["Legs"])
                ps = {k: p for k, side, p in legs if side == "P"}
                cs = {k: p for k, side, p in legs if side == "C"}
                same = set(ps) & set(cs)
                for k in same:
                    day["atm"].append((k, ps[k], cs[k]))
                for k, p in ps.items():
                    if k not in same:
                        day["P"].setdefault(k, []).append(p)
                for k, p in cs.items():
                    if k not in same:
                        day["C"].setdefault(k, []).append(p)
    mean = lambda xs: sum(xs) / len(xs)
    days = {}
    for d, a in acc.items():
        if not a["spots"]:
            continue
        spot = sorted(a["spots"])[len(a["spots"]) // 2]
        atm = None
        if a["atm"]:
            k = sorted(x[0] for x in a["atm"])[len(a["atm"]) // 2]
            same_k = [x for x in a["atm"] if x[0] == k]
            atm = (k, mean([x[1] for x in same_k]), mean([x[2] for x in same_k]))
        days[d] = {"spot": spot, "atm": atm,
                   "puts": {k: mean(v) for k, v in a["P"].items()},
                   "calls": {k: mean(v) for k, v in a["C"].items()}}
    return days, all_dates


LEG_SQL = r"(\d+)\s+\w+\s+\d+\s+([\d.]+)\s+([PC])\s+(STO|BTO)\s+([\d.]+)"      # same pattern as LEG_RE


def read_oo_db(con, analytics_db, blocks, underlying, entry, date_from, date_to, bars):
    """Same result as read_oo, but from the TradeBlocks table trades.trade_data (analytics.duckdb,
    attached read-only) with the legs parsed and aggregated in SQL. trade_data has no 'Opening Price',
    so the spot is the entry bar's open from market.spot (the trade logs' Opening Price differs from it
    by up to about 1 point on a few days, see definitions.md). Raw OTM node counts per side are counted
    in SQL and returned as raw_put / raw_call."""
    if not os.path.exists(analytics_db):
        fail(f"TradeBlocks database not found: {analytics_db}")
    con.execute(f"ATTACH '{analytics_db}' AS tbdb (READ_ONLY)")
    ph = ",".join("?" * len(blocks))
    lo, hi = date_from or "0000-01-01", date_to or "9999-12-31"
    base = [*blocks, lo, hi]
    found = {r[0] for r in con.execute(
        f"SELECT DISTINCT block_id FROM tbdb.trades.trade_data WHERE block_id IN ({ph})", blocks).fetchall()}
    if found != set(blocks):
        fail(f"blocks not in trades.trade_data: {sorted(set(blocks) - found)}")
    all_dates = {r[0] for r in con.execute(
        f"SELECT DISTINCT CAST(date_opened AS VARCHAR) FROM tbdb.trades.trade_data WHERE block_id IN ({ph}) "
        "AND CAST(date_opened AS VARCHAR) BETWEEN ? AND ?", base).fetchall()}
    con.execute(f"""CREATE TEMP TABLE oo_legs AS
        SELECT tid, d, k, side, price, COUNT(DISTINCT side) OVER (PARTITION BY tid, k) AS n_sides FROM (
          SELECT tid, d, CAST(regexp_extract(p, '{LEG_SQL}', 2) AS DOUBLE) AS k,
                 regexp_extract(p, '{LEG_SQL}', 3) AS side,
                 CAST(regexp_extract(p, '{LEG_SQL}', 5) AS DOUBLE) AS price
          FROM (SELECT tid, d, unnest(string_split(legs, '|')) AS p FROM (
                  SELECT row_number() OVER () AS tid, CAST(date_opened AS VARCHAR) AS d, legs
                  FROM tbdb.trades.trade_data
                  WHERE block_id IN ({ph}) AND substr(time_opened, 1, 5) = '{entry}'
                    AND CAST(date_opened AS VARCHAR) BETWEEN ? AND ?)) 
          WHERE regexp_matches(p, '{LEG_SQL}'))""", base)
    # ATM node: straddle legs (same strike put + call in one trade); per day the median strike (upper
    # median, as in read_oo) and the mean prices of the straddles at that strike
    atm = {d: (k, pp, cp) for d, k, pp, cp in con.execute("""
        WITH s AS (SELECT tid, d, k, MAX(price) FILTER (WHERE side = 'P') AS pp,
                          MAX(price) FILTER (WHERE side = 'C') AS cp
                   FROM oo_legs WHERE n_sides = 2 GROUP BY tid, d, k),
        m AS (SELECT d, list_sort(list(k))[len(list(k)) // 2 + 1] AS km FROM s GROUP BY d)
        SELECT s.d, s.k, AVG(pp), AVG(cp) FROM s JOIN m ON s.d = m.d AND s.k = m.km GROUP BY s.d, s.k""").fetchall()}
    wings = con.execute("""SELECT d, side, k, AVG(price) FROM oo_legs WHERE n_sides = 1 GROUP BY d, side, k""").fetchall()
    days = {}
    for d, side, k, price in wings:
        b = bars.get(d)
        if b is None or b["open"] is None:
            continue
        day = days.setdefault(d, {"spot": round(b["open"], 2), "atm": atm.get(d), "puts": {}, "calls": {},
                                  "raw_put": 0, "raw_call": 0})
        (day["puts"] if side == "P" else day["calls"])[k] = price
    raw = {d: (np_, nc) for d, np_, nc in con.execute("""
        SELECT w.d, COUNT(*) FILTER (WHERE side = 'P' AND k < b.o), COUNT(*) FILTER (WHERE side = 'C' AND k > b.o)
        FROM (SELECT DISTINCT d, side, k FROM oo_legs WHERE n_sides = 1) w
        JOIN (SELECT CAST(date AS VARCHAR) AS d, open AS o FROM market.spot WHERE ticker = ? AND time = ?) b
          ON w.d = b.d GROUP BY w.d""", [underlying, entry]).fetchall()}
    for d, rec in days.items():
        rec["raw_put"], rec["raw_call"] = raw.get(d, (0, 0))
    return days, all_dates


def quote_table_ok(con):
    try:
        cols = {d[0] for d in con.execute("SELECT * FROM market.option_quote_minutes LIMIT 0").description}
    except Exception:
        return False
    return QUOTE_COLS.issubset(cols)


def quotes_to_input(rows, d, spot):
    """rows: [(ticker, bid, ask)] of one entry minute -> same dict as read_oo (source 'quotes'), or None.
    OCC tickers are parsed for expiry, right and strike; weekly (W) roots are preferred; the ATM node is the
    strike nearest to spot with both bids > 0; wings are cleaned by cboe_filter (first zero bid stops)."""
    yymmdd = datetime.strptime(d, "%Y-%m-%d").strftime("%y%m%d")
    parsed = []
    for tk, bid, ask in rows:
        m = OCC_RE.match(tk or "")
        if m and m.group(2) == yymmdd:
            parsed.append((m.group(1), m.group(3), int(m.group(4)) / 1000.0, bid, ask))
    if any(r[0].endswith("W") for r in parsed):          # weekly (PM-settled) contracts expire at 16:00
        parsed = [r for r in parsed if r[0].endswith("W")]
    puts = {k: (b, a) for _, cp, k, b, a in parsed if cp == "P"}
    calls = {k: (b, a) for _, cp, k, b, a in parsed if cp == "C"}
    if not puts or not calls:
        return None
    atm = None
    both = sorted(set(puts) & set(calls), key=lambda k: abs(k - spot))
    for k in both:
        pb, pa = puts[k]
        cb, ca = calls[k]
        if pb and pa and cb and ca and pb > 0 and cb > 0:
            atm = (k, 0.5 * (pb + pa), 0.5 * (cb + ca))
            break
    return {"spot": spot, "atm": atm, "puts": cboe_filter(puts, True, spot),
            "calls": cboe_filter(calls, False, spot)}


def read_quotes(con, underlying, d, entry, spot, t):
    """0DTE quotes of the underlying at the entry minute (centre = spot) -> dict as read_oo, or None."""
    rows = con.execute(
        "SELECT ticker, bid, ask FROM market.option_quote_minutes WHERE underlying=? AND date=? "
        "AND substr(CAST(time AS VARCHAR),1,5)=?", [underlying, d, entry]).fetchall()
    return quotes_to_input(rows, d, spot)


def read_quotes_multi(con, underlying, d, entries, spots):
    """Same as read_quotes for several entry minutes of one day with one query. spots: {entry: spot}.
    Returns {entry: input dict or None}."""
    labels = ",".join(f"'{e}'" for e in entries)
    rows = con.execute(
        f"SELECT substr(CAST(time AS VARCHAR),1,5), ticker, bid, ask FROM market.option_quote_minutes "
        f"WHERE underlying=? AND date=? AND substr(CAST(time AS VARCHAR),1,5) IN ({labels})",
        [underlying, d]).fetchall()
    by = {}
    for tm, tk, bid, ask in rows:
        by.setdefault(tm, []).append((tk, bid, ask))
    return {e: (quotes_to_input(by[e], d, spots[e]) if e in by and spots.get(e) else None) for e in entries}


FWD_SQL = """
CREATE OR REPLACE TEMP TABLE fz AS SELECT * FROM fq WHERE ask >= bid;
CREATE OR REPLACE TEMP TABLE fpc AS
  SELECT p.em, p.k, (p.bid + p.ask) / 2 AS pm, (c.bid + c.ask) / 2 AS cm
  FROM fz p JOIN fz c ON p.em = c.em AND p.k = c.k AND p.cp = 'P' AND c.cp = 'C'
  WHERE p.bid > 0 AND c.bid > 0;
CREATE OR REPLACE TEMP TABLE fatm AS
  SELECT em, arg_min(k, abs(cm - pm)) AS k, arg_min(pm, abs(cm - pm)) AS pm, arg_min(cm, abs(cm - pm)) AS cm
  FROM fpc GROUP BY em;
CREATE OR REPLACE TEMP TABLE ff AS SELECT *, k + cm - pm AS fwd FROM fatm;
CREATE OR REPLACE TEMP TABLE fo AS
  SELECT z.em, z.cp, z.k, (z.bid + z.ask) / 2 AS mid, f.fwd, (z.bid <= 0) AS zb,
         CASE WHEN z.cp = 'P' THEN -z.k ELSE z.k END AS ord
  FROM fz z JOIN ff f ON z.em = f.em
  WHERE (z.cp = 'P' AND z.k < f.fwd) OR (z.cp = 'C' AND z.k > f.fwd);
CREATE OR REPLACE TEMP TABLE fw AS
  SELECT *, (zb AND coalesce(lag(zb) OVER (PARTITION BY em, cp ORDER BY ord), false)) AS stp FROM fo;
CREATE OR REPLACE TEMP TABLE fw2 AS
  SELECT *, max(stp::INT) OVER (PARTITION BY em, cp ORDER BY ord ROWS UNBOUNDED PRECEDING) AS stopped FROM fw;
SELECT em, 'atm' AS kind, k, pm AS a, cm AS b, fwd FROM ff
UNION ALL
SELECT em, cp AS kind, k, mid AS a, NULL AS b, fwd FROM fw2 WHERE NOT zb AND stopped = 0
ORDER BY em, kind, k
"""


def forward_chains(con, underlying, d, entries):
    """Quote chains centred on the put-call parity forward, one SQL pass for the entries.
    Forward F = K + C - P at the strike with the smallest |C - P| among strikes with both bids > 0 (mids,
    ask >= bid). OTM options only (puts K < F, calls K > F); zero-bid quotes are dropped, and walking outward
    from the forward everything beyond TWO consecutive zero bids (the CBOE rule). Weekly (W) roots are
    preferred. Returns {entry: {'spot': F, 'fwd': F, 'atm': (K, put_mid, call_mid), 'puts': {K: mid},
    'calls': {K: mid}}} for entries with a parity strike."""
    ymd = d[2:4] + d[5:7] + d[8:10]
    labels = ",".join(f"'{e}'" for e in entries)
    pat = r"^([A-Z]+)(\d{6})([CP])(\d{8})$"
    con.execute(f"""CREATE OR REPLACE TEMP TABLE fq0 AS
        SELECT regexp_extract(ticker, '{pat}', 1) AS root, regexp_extract(ticker, '{pat}', 3) AS cp,
               CAST(regexp_extract(ticker, '{pat}', 4) AS DOUBLE) / 1000.0 AS k,
               CAST(substr(CAST(time AS VARCHAR), 1, 2) AS INT) * 60 + CAST(substr(CAST(time AS VARCHAR), 4, 2) AS INT) AS em,
               bid, ask
        FROM market.option_quote_minutes
        WHERE underlying = ? AND date = ? AND substr(CAST(time AS VARCHAR), 1, 5) IN ({labels})
          AND regexp_extract(ticker, '{pat}', 2) = '{ymd}'
          AND bid IS NOT NULL AND ask IS NOT NULL AND NOT isnan(bid) AND NOT isnan(ask)""", [underlying, d])
    con.execute("""CREATE OR REPLACE TEMP TABLE fq AS SELECT cp, k, em, bid, ask FROM fq0
        WHERE root LIKE '%W' OR NOT (SELECT coalesce(bool_or(root LIKE '%W'), false) FROM fq0)""")
    statements = [x for x in FWD_SQL.split(";\n") if x.strip()]
    for st in statements[:-1]:
        con.execute(st)
    rows = con.execute(statements[-1]).fetchall()
    out = {}
    for em, kind, k, a_, b_, fwd in rows:
        e = f"{em // 60:02d}:{em % 60:02d}"
        r = out.setdefault(e, {"spot": fwd, "fwd": fwd, "atm": None, "puts": {}, "calls": {}})
        if kind == "atm":
            r["atm"] = (k, a_, b_)
        else:
            r["puts" if kind == "P" else "calls"][k] = a_
    return out


# ---------------------------------------------------------------- optional variants (flags)

def bkm_integrals(xn, vn, s, t, wings="trunc", step=STEP):
    """BKM contract prices V, W, X (r = 0) of R^2, R^3, R^4 with R = ln(S_T / s), s = centre (spot or forward).
    Same smile (PCHIP in x = ln(K/s)/sqrt(T)), wing treatment and strike grid as implied_semivariance."""
    xn = np.asarray(xn, float)
    vn = np.asarray(vn, float)
    f = _iv_fn(xn, vn, wings)
    sq = math.sqrt(t)
    if wings == "trunc":
        x_lo, x_hi = xn[0], xn[-1]
    else:
        x_lo = -max(10.0 * vn[0], abs(xn[0]) + 1.0)
        x_hi = max(10.0 * vn[-1], abs(xn[-1]) + 1.0)
    big_v = big_w = big_x = 0.0
    for put in (True, False):
        k0, k1 = (s * math.exp(x_lo * sq), s) if put else (s, s * math.exp(x_hi * sq))
        n = max(int(math.ceil((k1 - k0) / step)), 2)
        k = np.linspace(k0, k1, n + 1)
        sig = f(np.log(k / s) / sq)
        opt = bs_otm(s, k, sig, t, put) / k ** 2
        w = np.full(len(k), k[1] - k[0])
        w[0] = w[-1] = w[0] / 2
        if put:
            ll = np.log(s / k)
            v_, w_, x_ = 2 * (1 + ll), -(6 * ll + 3 * ll ** 2), 12 * ll ** 2 + 4 * ll ** 3
        else:
            ll = np.log(k / s)
            v_, w_, x_ = 2 * (1 - ll), 6 * ll - 3 * ll ** 2, 12 * ll ** 2 - 4 * ll ** 3
        big_v += float((v_ * opt * w).sum())
        big_w += float((w_ * opt * w).sum())
        big_x += float((x_ * opt * w).sum())
    return big_v, big_w, big_x


def moments_from_vwx(big_v, big_w, big_x):
    """BKM (2003) with r = 0 from the contract prices (or from the realized M2, M3, M4):
    mu = -V/2 - W/6 - X/24, var = V - mu^2, skew and raw kurtosis (3 = Gaussian). None if var <= 0."""
    mu = -big_v / 2 - big_w / 6 - big_x / 24
    var = big_v - mu ** 2
    if not var > 0:
        return None
    skew = (big_w - 3 * mu * big_v + 2 * mu ** 3) / var ** 1.5
    kurt = (big_x - 4 * mu * big_w + 6 * mu ** 2 * big_v - 3 * mu ** 4) / var ** 2
    return {"mu": mu, "var": var, "skew": skew, "kurt": kurt}


def q_moments(xs, vs, s, t, k_std=K_STD):
    """Q moments (var annualised on the trading-time clock, skew, raw kurtosis) from the smile: trunc wings on
    the nodes with |x / sigma_atm| <= k_std, sigma_atm = smile at x = 0 (linear interpolation); needs >= 4 nodes."""
    xa, va = np.asarray(xs, float), np.asarray(vs, float)
    sig = float(np.interp(0.0, xa, va))
    sel = np.abs(xa / sig) <= k_std
    if sel.sum() < MIN_NODES:
        return None
    m = moments_from_vwx(*bkm_integrals(xa[sel], va[sel], s, t, "trunc"))
    if m is None:
        return None
    return {"var": m["var"] / t, "skew": m["skew"], "kurt": m["kurt"]}


def p_moments(m2, m3, m4, t):
    """P moments (var annualised, skew, raw kurtosis) from the aggregation-consistent realized M2, M3, M4."""
    m = moments_from_vwx(m2, m3, m4)
    if m is None:
        return None
    return {"var": m["var"] / t, "skew": m["skew"], "kurt": m["kurt"]}


def path_stats(con, underlying, entries, step, d_from, d_to):
    """Realized path sums in SQL on market.spot for several entries at once. Returns {(date, entry): dict} with
      n, first_m, last_m   number of returns, first / last grid minute (minutes since 00:00)
      down, up, tot        sums of r^2 over r < 0, r > 0, all (not divided by T)
      m2, m3, m4           aggregation-consistent raw moments, y = cumulative log return before step i,
                           h = e^r - 1 - r:  M2 = sum[r^2 - 2yh], M3 = sum[-3y^2h + 3yr^2 + r^3],
                           M4 = sum[-4y^3h + 6y^2r^2 + 4yr^3 + r^4]
      sum_r                sum of the returns (= ln of last grid close / first grid close)
      nr, sr               number and sum of ln(high/low)^2 of the 1-minute bars after the entry bar
      em                   entry minute
    Returns are between consecutive closes on the grid of every `step` minutes starting at the entry minute
    (step 1 = every minute, 5 = every 5th minute), up to 16:00."""
    ent = ",".join(f"({int(e[:2]) * 60 + int(e[3:5])})" for e in entries)
    cond, par = ["ticker = ?", "time >= '09:30'", "time <= '16:00'"], [underlying]
    if d_from:
        cond.append("CAST(date AS VARCHAR) >= ?")
        par.append(d_from)
    if d_to:
        cond.append("CAST(date AS VARCHAR) <= ?")
        par.append(d_to)
    rows = con.execute(f"""
        WITH ent(em) AS (VALUES {ent}),
        s AS (SELECT CAST(date AS VARCHAR) AS d, CAST(substr(time, 1, 2) AS INT) * 60 + CAST(substr(time, 4, 2) AS INT) AS m,
                     high, low, close FROM market.spot WHERE {' AND '.join(cond)}),
        g AS (SELECT s.d, e.em, s.m, s.high, s.low, s.close FROM s JOIN ent e ON s.m >= e.em),
        rg AS (SELECT d, em, count(*) FILTER (WHERE m > em AND high > 0 AND low > 0) AS nr,
                      sum(power(ln(high / low), 2)) FILTER (WHERE m > em AND high > 0 AND low > 0) AS sr
               FROM g GROUP BY d, em),
        x AS (SELECT d, em, m, close, ln(close / lag(close) OVER w) AS r,
                     ln(lag(close) OVER w / first_value(close) OVER w) AS y
              FROM g WHERE (m - em) % {int(step)} = 0 AND close > 0
              WINDOW w AS (PARTITION BY d, em ORDER BY m)),
        z AS (SELECT d, em, m, r, y, exp(r) - 1 - r AS h FROM x WHERE r IS NOT NULL)
        SELECT z.d, z.em, count(*), min(z.m), max(z.m),
               coalesce(sum(CASE WHEN r < 0 THEN r * r END), 0), coalesce(sum(CASE WHEN r > 0 THEN r * r END), 0), sum(r * r),
               sum(r * r - 2 * y * h), sum(-3 * y * y * h + 3 * y * r * r + r * r * r),
               sum(-4 * y * y * y * h + 6 * y * y * r * r + 4 * y * r * r * r + r * r * r * r),
               sum(r), max(rg.nr), max(rg.sr)
        FROM z JOIN rg ON z.d = rg.d AND z.em = rg.em GROUP BY z.d, z.em""", par).fetchall()
    out = {}
    for d, em, n, fm, lm, dn, up, tot, m2, m3, m4, sr_, nr, sr in rows:
        out[(d, f"{em // 60:02d}:{em % 60:02d}")] = {
            "n": n, "first_m": fm, "last_m": lm, "down": dn, "up": up, "tot": tot, "m2": m2, "m3": m3,
            "m4": m4, "sum_r": sr_, "nr": nr or 0, "sr": sr or 0.0, "em": em}
    return out


def path_complete(p, step):
    """True if the path of path_stats() runs from the entry minute to the last grid minute <= 16:00 without gaps."""
    if not p:
        return False
    em = p["em"]
    n_exp = (16 * 60 - em) // step
    return p["first_m"] == em + step and p["n"] == n_exp and p["last_m"] == em + step * n_exp


def range_complete(p):
    return bool(p) and p["nr"] == 16 * 60 - p["em"]


def entry_opens(con, underlying, entries, d_from, d_to):
    """{(date, entry): open of the entry bar} from market.spot (close if the table has no open column)."""
    cols = {d[0] for d in con.execute("SELECT * FROM market.spot LIMIT 0").description}
    col = "open" if "open" in cols else "close"
    labels = ",".join(f"'{e}'" for e in entries)
    cond, par = [f"ticker = ?", f"time IN ({labels})"], [underlying]
    if d_from:
        cond.append("CAST(date AS VARCHAR) >= ?")
        par.append(d_from)
    if d_to:
        cond.append("CAST(date AS VARCHAR) <= ?")
        par.append(d_to)
    rows = con.execute(f"SELECT CAST(date AS VARCHAR), time, {col} FROM market.spot WHERE {' AND '.join(cond)}", par).fetchall()
    return {(d, tm[:5]): o for d, tm, o in rows if o}


def st_from_paths(p1, p5, t, op, freq):
    """bar_stats()-like dict for one (day, entry) from path_stats results (multi mode). rv / rv_5m use the
    population variance of the returns, like bar_stats; the semivariances come from the grid of `freq`."""
    em = p1["em"]
    n1 = p1["n"]
    var1 = p1["tot"] / n1 - (p1["sum_r"] / n1) ** 2
    rv = math.sqrt(max(var1, 0.0) * MINUTES_PER_DAY * TRADING_DAYS) if n1 >= 2 else None
    n5 = p5["n"] if p5 else 0
    rv5 = None
    if p5 and n5 >= 2:
        var5 = p5["tot"] / n5 - (p5["sum_r"] / n5) ** 2
        rv5 = math.sqrt(max(var5, 0.0) * (MINUTES_PER_DAY // 5) * TRADING_DAYS)
    src = p1 if freq == "1m" else p5
    dn, up = (src["down"], src["up"]) if src else (0.0, 0.0)
    return {"n_bars": n1 + 1, "has_entry": p1["first_m"] == em + 1, "last_min": p1["last_m"], "open": op,
            "rv": rv, "rv_5m": rv5, "n_ret_5m": n5, "down": dn / t, "up": up / t, "total": (dn + up) / t}


# ---- leg VRP at the 16-delta strike (Gram-Charlier Q, trailing P)

def bs_fwd(f, k, sigma, t, is_put):
    """Black-Scholes value (r = 0, forward f) of a call (is_put 0) or put (is_put 1); arrays allowed."""
    f, k, sigma, is_put = np.broadcast_arrays(*(np.asarray(v, float) for v in (f, k, sigma, is_put)))
    st = sigma * np.sqrt(t)
    d1 = (np.log(f / k) + 0.5 * st * st) / st
    call = f * ndtr(d1) - k * ndtr(d1 - st)
    return np.where(is_put > 0.5, call - f + k, call)


def cs_terms(f, k, sigma, t):
    """Corrado-Su terms Q3, Q4 per unit skew / excess kurtosis (identical for calls and puts, r = 0)."""
    f, k, sigma = np.broadcast_arrays(*(np.asarray(v, float) for v in (f, k, sigma)))
    s = sigma * np.sqrt(t)
    d = (np.log(f / k) + 0.5 * s * s) / s
    n = np.exp(-0.5 * d * d) / math.sqrt(2 * math.pi)
    big_n = ndtr(d)
    q3 = f * s / 6.0 * ((2 * s - d) * n + s * s * big_n)
    q4 = f * s / 24.0 * ((d * d - 1 - 3 * s * (d - s)) * n + s ** 3 * big_n)
    return q3, q4


def gc_value(f, k, sigma, t, skew, kurt, is_put):
    """Gram-Charlier option value: BS(f, k, sigma, t) + skew * Q3 + (kurt - 3) * Q4 (kurt = raw, 3 = Gaussian)."""
    q3, q4 = cs_terms(f, k, sigma, t)
    return bs_fwd(f, k, sigma, t, is_put) + np.asarray(skew, float) * q3 + (np.asarray(kurt, float) - 3.0) * q4


GC_LO = np.array([0.01, -3.0, 1.0])
GC_HI = np.array([3.0, 3.0, 60.0])


def fit_gc(f, t, ks, mids, sigma0):
    """Least-squares fit of (sigma, skew, kurt) to OTM mids (equal price weights, index points), bounds
    sigma [0.01, 3], skew [-3, 3], kurt [1, 60]; starts (sigma0, 0, 3) and (ATM-price sigma, 0, 3), the lower
    cost wins. Returns dict sigma, skew, kurt, rmse, ok, or None."""
    ks = np.asarray(ks, float)
    mids = np.asarray(mids, float)

    def fun(x):
        return gc_value(f, ks, x[0], t, x[1], x[2], (ks < f).astype(float)) - mids

    i_atm = int(np.argmin(np.abs(ks - f)))
    s_atm = float(np.clip(2.5 * mids[i_atm] / (f * math.sqrt(t)), 0.02, 2.0))
    best = None
    for st in ([sigma0, 0.0, 3.0], [s_atm, 0.0, 3.0]):
        try:
            r = least_squares(fun, np.clip(np.array(st, float), GC_LO + 1e-6, GC_HI - 1e-6), bounds=(GC_LO, GC_HI),
                              x_scale=np.array([0.1, 0.5, 3.0]), xtol=1e-12, ftol=1e-12, gtol=1e-12, max_nfev=400)
        except Exception:
            continue
        if best is None or r.cost < best.cost:
            best = r
    if best is None:
        return None
    res = fun(best.x)
    return {"sigma": float(best.x[0]), "skew": float(best.x[1]), "kurt": float(best.x[2]),
            "rmse": float(np.sqrt(np.mean(res ** 2))), "ok": bool(best.success)}


def pick_delta(chain, t, put, target=LEG_DELTA, tol=LEG_TOL):
    """Strike of the OTM option whose Black-Scholes |delta| (own IV, r = 0, centre = forward) is nearest to
    target %, within tol * target; the first minimum in ascending strike order. Returns (strike, delta, mid) or None."""
    s = chain["fwd"]
    book = chain["puts"] if put else chain["calls"]
    if not book:
        return None
    ks = np.array(sorted(book), float)
    ms = np.array([book[k] for k in sorted(book)], float)
    keep = (ks < s) if put else (ks > s)
    ks, ms = ks[keep], ms[keep]
    if not len(ks):
        return None
    iv = iv_from_price_vec(ms, s, ks, t, put)
    g = np.isfinite(iv)
    if not g.any():
        return None
    ks, ms, iv = ks[g], ms[g], iv[g]
    sd = iv * math.sqrt(t)
    d1 = (np.log(s / ks) + 0.5 * sd * sd) / sd
    dl = ndtr(-d1) if put else ndtr(d1)
    i = int(np.argmin(np.abs(dl - target / 100)))
    if abs(dl[i] * 100 - target) > tol * target:
        return None
    return float(ks[i]), float(dl[i]), float(ms[i])


def sample_skew_kurt(z):
    z = np.asarray(z, float)
    c = z - z.mean()
    m2 = (c ** 2).mean()
    return float((c ** 3).mean() / m2 ** 1.5), float((c ** 4).mean() / m2 ** 2)


def trailing_p(hist, date, rv_t, t):
    """Trailing P world for `date` from the sessions strictly before it. hist = (dates, r_term, rv_sum) of the
    sessions with a complete 1-minute path from this entry minute (sorted). kappa = sqrt(mean(r^2 / rv)) over the
    last LEG_WIN sessions, z = r / (kappa sqrt(rv)), skew / kurtosis of z, sigma = kappa sqrt(rv_t / t)
    (annualised). None with fewer than LEG_MIN_HIST sessions."""
    dates, r, rv = hist
    j = int(np.searchsorted(dates, date, side="left"))
    if j < LEG_MIN_HIST or not rv_t > 0:
        return None
    sl = slice(max(0, j - LEG_WIN), j)
    kappa = math.sqrt(np.mean(r[sl] ** 2 / rv[sl]))
    sk, ku = sample_skew_kurt(r[sl] / (kappa * np.sqrt(rv[sl])))
    return {"sigma": kappa * math.sqrt(rv_t / t), "skew": sk, "kurt": ku, "kappa": kappa, "n_hist": j}


def build_hist(path1):
    """{entry: (dates, r_term, rv_sum)} from path_stats(step=1) over all sessions with a complete path."""
    acc = {}
    for (d, e), p in path1.items():
        if path_complete(p, 1):
            acc.setdefault(e, []).append((d, p["sum_r"], p["tot"]))
    return {e: (np.array([x[0] for x in sorted(v)]), np.array([x[1] for x in sorted(v)], float),
                np.array([x[2] for x in sorted(v)], float)) for e, v in acc.items()}


def leg_vrp(chain, t, hist, d, rv_t):
    """V1 leg VRP of the short 16-delta put and call, in index points per contract unit (x100 = USD):
    V_GC(Q) - V_GC(P, mean 0) per leg. Q = Gram-Charlier fit on the OTM mids in [kp - 100, kc + 100] (plus the
    OTM-side quote of the parity strike); P = trailing world of trailing_p with the same-day 1-minute RV.
    chain: forward_chains() entry. Returns dict leg_kp, leg_kc, leg_put, leg_call, leg_vrp or None."""
    if not chain or chain["atm"] is None or hist is None:
        return None
    pp, pc = pick_delta(chain, t, True), pick_delta(chain, t, False)
    if not (pp and pc):
        return None
    p = trailing_p(hist, d, rv_t, t)
    if p is None:
        return None
    f = chain["fwd"]
    kpl, kcl = pp[0] - LEG_WING, pc[0] + LEG_WING
    pts = [(k, m) for k, m in chain["puts"].items() if kpl <= k < f] + [(k, m) for k, m in chain["calls"].items() if f < k <= kcl]
    ak, apm, acm = chain["atm"]
    pts.append((ak, apm if ak < f else acm))
    pts = sorted(set(pts))
    if len(pts) < 8:
        return None
    nodes = build_nodes(f, t, chain["atm"], chain["puts"], chain["calls"])
    sig0 = float(np.interp(0.0, nodes[0], nodes[1])) if nodes else 0.2
    fit = fit_gc(f, t, np.array([x[0] for x in pts]), np.array([x[1] for x in pts]), sig0)
    if fit is None or not fit["ok"]:
        return None
    out = {"leg_kp": pp[0], "leg_kc": pc[0]}
    for name, k, put in (("leg_put", pp[0], 1.0), ("leg_call", pc[0], 0.0)):
        out[name] = float(gc_value(f, k, fit["sigma"], t, fit["skew"], fit["kurt"], put)
                          - gc_value(f, k, p["sigma"], t, p["skew"], p["kurt"], put))
    out["leg_vrp"] = out["leg_put"] + out["leg_call"]
    return out


# ---------------------------------------------------------------- preflight

FIX_BARS = ("market-data: fetch_bars (timespan 1m) for {u} and these dates")
FIX_NODES = ("market-data: fetch_quotes for 0DTE {u} options at {e} (only if the provider offers option quotes), "
             "or oo-capture: Option Omega 0DTE ATM straddle plus strangles (about 40/30/25/20/16/10/7/5/3/2/1 delta) "
             "entered at {e}, held to expiry, imported as TradeBlocks blocks and passed with --block "
             "(new backtests only with the user's consent)")


def minute_of(tm):
    return int(tm[:2]) * 60 + int(tm[3:5])


def bar_stats(con, underlying, entry, t, d_from, d_to):
    """Per-day bar coverage and realized statistics, all in SQL (window functions) on market.spot,
    from the entry bar to 16:00. Returns date -> dict with
      n_bars, has_entry, last_time, open (entry-bar open), close (entry-bar close),
      rv / rv_5m   annualised std (decimal) of 1m / 5m log returns, None if < 2 returns,
      n_ret_5m, down / up / total  realized semivariance of the 5m returns divided by t (variance units).
    5m closes are those whose minute is congruent to the entry minute mod 5; returns run between
    consecutive such bars; rv uses VAR_POP (mean-subtracted, divisor n) like the former Python code."""
    cols = {d[0] for d in con.execute("SELECT * FROM market.spot LIMIT 0").description}
    opn = "FIRST(open ORDER BY time)" if "open" in cols else "FIRST(close ORDER BY time)"
    em = int(entry[3:5]) % 5
    rows = con.execute(f"""
        WITH b AS (
          SELECT date, time, open, close,
                 CASE WHEN close > 0 AND lag(close) OVER w > 0 THEN ln(close / lag(close) OVER w) END AS r1,
                 CAST(substr(time, 4, 2) AS INTEGER) % 5 = ? AS on5
          FROM market.spot
          WHERE ticker = ? AND time >= ? AND time <= '16:00'
          WINDOW w AS (PARTITION BY date ORDER BY time)
        ), b5 AS (
          SELECT date,
                 CASE WHEN close > 0 AND lag(close) OVER w > 0 THEN ln(close / lag(close) OVER w) END AS r5
          FROM b WHERE on5
          WINDOW w AS (PARTITION BY date ORDER BY time)
        ), a1 AS (
          SELECT date, COUNT(*) AS n_bars, MIN(time) AS tmin, MAX(time) AS tmax,
                 {opn} AS o, FIRST(close ORDER BY time) AS c,
                 COUNT(r1) AS n1, VAR_POP(r1) AS v1
          FROM b GROUP BY date
        ), a5 AS (
          SELECT date, COUNT(r5) AS n5, VAR_POP(r5) AS v5,
                 COALESCE(SUM(r5 * r5) FILTER (WHERE r5 < 0), 0) AS sdown,
                 COALESCE(SUM(r5 * r5) FILTER (WHERE r5 > 0), 0) AS sup
          FROM b5 GROUP BY date
        )
        SELECT CAST(a1.date AS VARCHAR), n_bars, tmin, tmax, o, c, n1,
               CASE WHEN n1 >= 2 THEN sqrt(v1 * {MINUTES_PER_DAY} * {TRADING_DAYS}) END,
               COALESCE(n5, 0),
               CASE WHEN n5 >= 2 THEN sqrt(v5 * {MINUTES_PER_DAY // 5} * {TRADING_DAYS}) END,
               sdown / ?, sup / ?
        FROM a1 LEFT JOIN a5 USING (date)""", [em, underlying, entry, t, t]).fetchall()
    out = {}
    for d, n, tmin, tmax, o, c, n1, rv, n5, rv5, sd, su in rows:
        if (d_from and d < d_from) or (d_to and d > d_to):
            continue
        out[d] = {"n_bars": n, "has_entry": tmin == entry, "last_time": tmax, "open": o, "close": c,
                  "rv": rv, "rv_5m": rv5, "n_ret_5m": n5,
                  "down": sd or 0.0, "up": su or 0.0, "total": (sd or 0.0) + (su or 0.0)}
    return out


def preflight(con, underlying, entry, d_from, d_to, oo_days, oo_dates, use_quotes, t, t_min, bars, center="spot"):
    """Per-day status for every day in the covered period. Returns (days, items):
    days[date] = {'status': ok | bars | nodes | early_close, 'source', 'input', 'n_bars'};
    items = missing-item records (blocking), each with the fixing skill.
    bars: bar_stats() result (SQL). oo_days from the database path carry raw node counts
    (raw_put, raw_call, counted in SQL); fewer than MIN_NODES per side rejects the day without inversion.
    center 'forward': quotes come from forward_chains (parity forward as centre), the entry-bar
    open stays in input['spot0']."""
    universe = set(bars) | set(oo_dates)
    if oo_dates:                                   # the OO blocks define the period when given
        lo, hi = min(oo_dates), max(oo_dates)
        universe = {d for d in universe if lo <= d <= hi}
    days = {}
    for d in sorted(universe):
        info = bars.get(d)
        rec = {"status": "ok", "source": None, "input": None, "n_bars": info["n_bars"] if info else 0}
        if info is None or not info["has_entry"] or info["n_bars"] < t_min * MIN_BAR_SHARE:
            if info is not None and info["has_entry"] and info["last_time"] <= "13:05":
                rec["status"] = "early_close"      # half-day: no 16:00 close, not computable, not blocking
            else:
                rec["status"] = "bars"
            days[d] = rec
            continue
        cand = []
        if use_quotes:
            if center == "forward":
                ch = forward_chains(con, underlying, d, [entry]).get(entry)
                q = dict(ch, spot0=info["open"], chain=ch) if ch else None
            else:
                q = read_quotes(con, underlying, d, entry, info["open"], t)
            if q:
                cand.append(("quotes", q))
        if d in oo_days:
            cand.append(("oo", oo_days[d]))
        for src, inp in cand:
            if min(inp.get("raw_put", MIN_NODES), inp.get("raw_call", MIN_NODES)) < MIN_NODES:
                continue
            nodes = build_nodes(inp["spot"], t, inp["atm"], inp["puts"], inp["calls"])
            if nodes:
                rec.update(source=src, input=inp, nodes=nodes)
                break
        else:
            rec["status"] = "nodes"
        days[d] = rec
    items = []
    for status, kind, fix in (("bars", "spx_bars", FIX_BARS), ("nodes", "iv_nodes", FIX_NODES)):
        ds = sorted(d for d, r in days.items() if r["status"] == status)
        if ds:
            detail = (f"{underlying} 1m bars incomplete or entry bar {entry} missing" if status == "bars" else
                      f"no IV source with >= {MIN_NODES} OTM put and >= {MIN_NODES} OTM call nodes at {entry}")
            items.append({"kind": kind, "count": len(ds), "first": ds[0], "last": ds[-1],
                          "dates": ds, "detail": detail,
                          "fix": fix.format(u=underlying, e=entry),
                          "fix_skill": "market-data" if kind == "spx_bars" else "market-data or oo-capture"})
    return days, items


def print_preflight(days, items, entry, as_json):
    counts = {}
    for r in days.values():
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    srcs = {}
    for r in days.values():
        if r["source"]:
            srcs[r["source"]] = srcs.get(r["source"], 0) + 1
    summary = {"entry": entry, "days": len(days), "ok": counts.get("ok", 0), "bars_missing": counts.get("bars", 0),
               "nodes_missing": counts.get("nodes", 0), "early_close": counts.get("early_close", 0),
               "iv_source_days": srcs, "blocking": bool(items)}
    if as_json:
        print(json.dumps({"summary": summary, "missing": items}, indent=1))
        return
    print(f"preflight {entry}: {summary['days']} days, ok {summary['ok']} (sources {srcs}), "
          f"missing bars {summary['bars_missing']}, missing IV nodes {summary['nodes_missing']}, "
          f"half-days skipped {summary['early_close']}")
    for it in items:
        shown = ", ".join(it["dates"][:5]) + (" ..." if it["count"] > 5 else "")
        print(f"- {it['detail']}: {it['count']} days ({it['first']} .. {it['last']}; {shown})")
        print(f"  fix -> {it['fix']}")
    if not items:
        print("no blocking gaps")


# ---------------------------------------------------------------- compute

NON_AGG = {"date", "entry_time", "spot", "strike", "put", "call", "straddle", "t_minutes", "n_bars", "n_put_nodes",
           "n_call_nodes", "mintick_nodes", "iv_source", "leg_kp", "leg_kc", "n_entries", "weight"}


def digits(col):
    """Decimals of an output column (None = not rounded)."""
    if col in ("spot", "strike", "put", "call", "leg_kp", "leg_kc"):
        return None
    if col == "straddle":
        return 2
    if col.endswith("_var") or col == "varp":
        return 8
    if col in ("q_skew", "q_kurt", "p_skew", "p_kurt", "skewp", "kurtp") or col.startswith("leg_"):
        return 4
    if col.startswith("lnvrp"):
        return 5
    return 3


def fields_for(a):
    """Output columns: the v1/v2 columns, then the optional groups in EXTRA_FIELDS order; multi adds n_entries, weight."""
    f = list(FIELDS)
    for key, cols in EXTRA_FIELDS.items():
        if getattr(a, key, False):
            f += cols
    if getattr(a, "mode", "single") == "multi":
        f += ["n_entries", "weight"]
    return f


def dataset_fields_for(a):
    f = list(DATASET_FIELDS)
    for key, cols in EXTRA_FIELDS.items():
        if getattr(a, key, False):
            f += [c for c in cols if c not in NOT_IN_DATASET]
    return f


def timing_plan(fields, mode, entry):
    """import_daily_dataset timing per column. Single: IV / Q-only columns are 'open' (knownBy = entry), everything
    built with a realized quantity is 'close'. Multi: the daily value uses entries up to 15:45, so all 'close'."""
    cols = [c for c in fields if c != "date"]
    if mode == "multi":
        return {"open": [], "close": cols, "knownBy": None}
    return {"open": [c for c in cols if c in OPEN_COLUMNS], "close": [c for c in cols if c not in OPEN_COLUMNS],
            "knownBy": entry}


def _num(x):
    if x is None:
        return None
    x = float(x)
    return x if math.isfinite(x) else None


def entry_vals(a, t, rec, st, ctx=None):
    """Unrounded values of one (day, entry): every v1 / v2 column plus the enabled optional groups. None when the
    5-minute path has fewer than 2 returns. Missing items are absent or None."""
    ctx = ctx or {}
    inp = rec["input"]
    xs, vs, n_put, n_call, n_min = rec["nodes"]
    s_c = inp["spot"]                       # centre of the smile: spot, or the parity forward with --center forward
    s0 = inp.get("spot0", s_c)
    if st["n_ret_5m"] < 2:
        return None
    q = implied_semivariance(xs, vs, s_c, t, a.wings)
    rv, rv5 = st["rv"], st["rv_5m"]
    vol = lambda var: math.sqrt(var) * 100
    v = {"iv_down": vol(q["down"]), "iv_up": vol(q["up"]), "iv_mf": vol(q["total"]),
         "rv_down": vol(st["down"]), "rv_up": vol(st["up"]),
         "vrp_down": vol(q["down"]) - vol(st["down"]), "vrp_up": vol(q["up"]) - vol(st["up"]),
         "vrp_mf": vol(q["total"]) - vol(st["total"])}
    iv = None
    atm = inp["atm"]
    if atm is not None:
        k, put, call = atm
        straddle = put + call
        iv = implied_vol(straddle, s0, k, t, a.rate)
        if iv is not None and rv is not None:
            v.update(spot=s0, strike=k, put=put, call=call, straddle=straddle, iv=iv * 100, rv=rv * 100,
                     vrp=(iv - rv) * 100, rv_5m=rv5 * 100 if rv5 else None, vrp_5m=(iv - rv5) * 100 if rv5 else None)
        else:
            iv = None
    v.setdefault("spot", s0)
    if getattr(a, "sum_var", False):
        dn, up = q["down"] - st["down"], q["up"] - st["up"]
        v.update(iv_down_var=q["down"], iv_up_var=q["up"], rv_down_var=st["down"], rv_up_var=st["up"],
                 vrp_down_var=dn, vrp_up_var=up, vrp_sum_var=dn + up)
    if getattr(a, "moments", False):
        qm = q_moments(xs, vs, s_c, t)
        ps = ctx.get("ps_m")
        pm = p_moments(ps["m2"], ps["m3"], ps["m4"], t) if ps and path_complete(ps, 1 if a.rv_freq == "1m" else 5) else None
        if qm:
            v.update(q_var=qm["var"], q_skew=qm["skew"], q_kurt=qm["kurt"])
        if pm:
            v.update(p_var=pm["var"], p_skew=pm["skew"], p_kurt=pm["kurt"])
        if qm and pm:
            v.update(varp=qm["var"] - pm["var"], skewp=qm["skew"] - pm["skew"], kurtp=qm["kurt"] - pm["kurt"])
    p1 = ctx.get("ps1")
    if getattr(a, "leg", False) and path_complete(p1, 1):
        lg = leg_vrp(ctx.get("chain"), t, ctx.get("hist"), ctx.get("date"), p1["tot"])
        if lg:
            v.update(lg)
    rr = None
    if getattr(a, "range_rv", False) and range_complete(p1):
        rr = 100 * math.sqrt(p1["sr"] / (4 * math.log(2)) / t)
        v["rv_range"] = rr
        if iv is not None:
            v["vrp_range"] = iv * 100 - rr
    if getattr(a, "ln", False) and iv is not None:
        for name, r in (("lnvrp", rv), ("lnvrp_5m", rv5), ("lnvrp_range", rr / 100 if rr else None)):
            if r and r > 0 and name in v | {"lnvrp": 0, "lnvrp_5m": 0, "lnvrp_range": 0}:
                if name != "lnvrp_range" or rr:
                    v[name] = math.log(iv ** 2 / r ** 2)
    return {k: _num(x) for k, x in v.items()}


def round_vals(v, nd=3):
    out = {}
    for k, x in v.items():
        d = digits(k)
        out[k] = x if (x is None or nd is None or d is None) else round(x, d)
    return out


def day_row(underlying, d, entry, t_min, t, rec, a, st, ctx=None):
    """One output row (rounded). st = bar_stats()[d]: realized quantities come from SQL; Python does the
    IV inversion, the smile and the integral."""
    v = entry_vals(a, t, rec, st, dict(ctx or {}, date=d))
    if v is None:
        return None
    row = {"date": d, "entry_time": entry, "t_minutes": t_min, "n_bars": st["n_bars"],
           "n_put_nodes": rec["nodes"][2], "n_call_nodes": rec["nodes"][3], "mintick_nodes": rec["nodes"][4],
           "iv_source": rec["source"]}
    row.update(round_vals(v))
    return row


def daily_agg(vals, weights, weighted, min_valid=None):
    """Daily value of one column over the entries of a day: weighted by `weights` (tau) or plain mean over the
    finite entries; None with fewer than min_valid finite entries."""
    min_valid = MULTI_MIN_VALID if min_valid is None else min_valid
    pairs = [(x, w) for x, w in zip(vals, weights) if x is not None and math.isfinite(x)]
    if len(pairs) < min_valid:
        return None
    if weighted:
        return sum(x * w for x, w in pairs) / sum(w for _, w in pairs)
    return sum(x for x, _ in pairs) / len(pairs)


def write_csv(path, fields, rows):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    os.replace(tmp, path)


def run_multi(a, con, out, compute=True):
    """Multi mode: the 26 entries of MULTI_ENTRIES per day, one row per entry (optional --per-entry) and a daily
    aggregate per column over the entries, weighted by tau (minutes to 16:00) or equal, needing at least
    MULTI_MIN_VALID valid entries for that column. Quotes only (option_quote_minutes). Returns an exit code."""
    entries = MULTI_ENTRIES
    em_of = {e: minute_of(e) for e in entries}
    tmin_of = {e: 16 * 60 - em_of[e] for e in entries}
    t_of = {e: tmin_of[e] / MINUTES_PER_DAY / TRADING_DAYS for e in entries}
    wide = a.leg                                   # the trailing P world needs the whole history
    ps1 = path_stats(con, a.underlying, entries, 1, None if wide else a.date_from, None if wide else a.date_to)
    ps5 = path_stats(con, a.underlying, entries, 5, a.date_from, a.date_to)
    opens = entry_opens(con, a.underlying, entries, a.date_from, a.date_to)
    hist = build_hist(ps1) if a.leg else {}
    dates = sorted({d for d, _ in ps1 if (not a.date_from or d >= a.date_from) and (not a.date_to or d <= a.date_to)})
    fields = fields_for(a)
    agg_cols = [c for c in fields if c not in NON_AGG]
    weighted = a.weight == "tau"
    per_rows, rows, short = [], [], []
    for d in dates:
        need_chain = a.center == "forward" or a.leg
        chains = forward_chains(con, a.underlying, d, entries) if need_chain else {}
        if a.center == "forward":
            qin = chains
        else:
            qin = read_quotes_multi(con, a.underlying, d, entries, {e: opens.get((d, e)) for e in entries})
        vals = []
        for e in entries:
            p1, p5, q = ps1.get((d, e)), ps5.get((d, e)), qin.get(e)
            if not p1 or not q:
                continue
            t, tm = t_of[e], tmin_of[e]
            st = st_from_paths(p1, p5, t, opens.get((d, e)), a.rv_freq)
            if not st["has_entry"] or st["n_bars"] < tm * MIN_BAR_SHARE or st["last_min"] <= 13 * 60 + 5:
                continue
            inp = dict(q, spot0=opens.get((d, e), q["spot"])) if a.center == "forward" else q
            nodes = build_nodes(inp["spot"], t, inp["atm"], inp["puts"], inp["calls"])
            if not nodes:
                continue
            rec = {"input": inp, "nodes": nodes, "source": "quotes"}
            if not compute:
                vals.append((e, tm, {}))
                continue
            ctx = {"date": d, "ps1": p1, "ps_m": p1 if a.rv_freq == "1m" else p5, "hist": hist.get(e),
                   "chain": chains.get(e) if a.leg else None}
            v = entry_vals(a, t, rec, st, ctx)
            if v is not None:
                vals.append((e, tm, v))
                if a.per_entry:
                    pr = {"date": d, "entry_time": e, "t_minutes": tm, "n_bars": st["n_bars"], "n_put_nodes": nodes[2],
                          "n_call_nodes": nodes[3], "mintick_nodes": nodes[4], "iv_source": "quotes"}
                    pr.update(round_vals(v))
                    per_rows.append(pr)
        if len(vals) < MULTI_MIN_VALID:
            short.append((d, len(vals)))
        if not compute:
            continue
        row = {"date": d, "entry_time": "multi", "n_entries": len(vals), "weight": a.weight, "iv_source": "quotes"}
        got = False
        for c in agg_cols:
            x = daily_agg([v.get(c) for _, _, v in vals], [tm for _, tm, _ in vals], weighted)
            if x is not None:
                got = True
                dg = digits(c)
                row[c] = x if dg is None else round(x, dg)
        if got:
            rows.append(row)
    print(f"multi: {len(dates)} sessions with bars, {len(dates) - len(short)} with >= {MULTI_MIN_VALID} valid entries of "
          f"{len(entries)}; {len(short)} with fewer" + (f" (first: {', '.join(f'{d}:{n}' for d, n in short[:5])})" if short else ""))
    if not compute:
        return EXIT_GAPS if short and not a.allow_gaps else 0
    write_csv(out, fields, rows)
    if a.per_entry:
        write_csv(a.per_entry, [f for f in fields if f not in ("n_entries", "weight")], per_rows)
    if a.dataset:
        write_csv(a.dataset, dataset_fields_for(a), [r for r in rows if r.get("iv_mf") not in (None, "")])
        print("timing: " + json.dumps(timing_plan(dataset_fields_for(a), "multi", None)))
    print(f"wrote {out}: {len(rows)} daily rows ({a.weight}-weighted over entries; per-entry rows: {len(per_rows)})"
          + (f"; dataset {a.dataset}" if a.dataset else ""))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--block", action="append", default=[],
                    help="TradeBlocks block id of 0DTE strangles / ATM straddle at the entry time (repeatable)")
    ap.add_argument("--tradelog", action="append", default=[], help="trade log CSV (repeatable)")
    ap.add_argument("--trades", choices=("csv", "db"), default="csv",
                    help="where --block trades are read: csv = <data-dir>/<id>/tradelog.csv (default; has the "
                         "Opening Price), db = SQL on trades.trade_data in <data-dir>/analytics.duckdb "
                         "(spot = entry-bar open)")
    ap.add_argument("--data-dir", help="TradeBlocks data directory holding the blocks (default: folder of --market-db)")
    ap.add_argument("--market-db", required=True)
    ap.add_argument("--entry", help="single mode: entry time HH:MM (US Eastern), as in the trade logs; "
                                    "the user decides it beforehand")
    ap.add_argument("--underlying", default="SPX")
    ap.add_argument("--out", help="full CSV (default ./vrp_daily_HHMM.csv, multi: ./vrp_daily_multi.csv)")
    ap.add_argument("--dataset", help="also write an import_daily_dataset CSV here (a timing line is printed)")
    ap.add_argument("--from", dest="date_from")
    ap.add_argument("--to", dest="date_to")
    ap.add_argument("--rate", type=float, default=0.045,
                    help="risk-free rate for the v1 straddle IV only (the model-free part uses r = 0)")
    ap.add_argument("--wings", choices=WINGS, default="flat", help="smile beyond the outermost node")
    ap.add_argument("--mode", choices=("single", "multi"), default="single",
                    help="single = one entry time (--entry); multi = the 26 entries 09:32 .. 15:45, daily aggregate "
                         "over the entries (needs --weight, quotes only)")
    ap.add_argument("--weight", choices=("tau", "equal"),
                    help="multi mode: weight of the entries in the daily aggregate of EVERY column: tau = minutes "
                         "to 16:00, equal = plain mean. No default: it is fixed with the user.")
    ap.add_argument("--per-entry", help="multi mode: also write one row per day and entry here")
    ap.add_argument("--center", choices=("spot", "forward"), default="spot",
                    help="centre of the smile and the integrals: spot (entry-bar open, default) or the put-call "
                         "parity forward (quotes only; see the definitions)")
    ap.add_argument("--rv-freq", choices=("5m", "1m"), default="5m",
                    help="return frequency of rv_down / rv_up and of the realized moments p_* (default 5m)")
    ap.add_argument("--sum-var", dest="sum_var", action="store_true",
                    help="add the variance form: iv/rv/vrp down and up in variance units and vrp_sum_var")
    ap.add_argument("--moments", action="store_true", help="add q_var/skew/kurt, p_*, varp, skewp, kurtp (BKM)")
    ap.add_argument("--leg", action="store_true", help="add the V1 leg VRP at the 16-delta strikes (quotes only)")
    ap.add_argument("--range-rv", dest="range_rv", action="store_true",
                    help="add rv_range (Parkinson, 1-minute high/low) and vrp_range")
    ap.add_argument("--ln", action="store_true", help="add lnvrp = ln(IV^2 / RV^2) for rv, rv_5m and rv_range")
    ap.add_argument("--force", action="store_true", help="recompute days already in --out")
    ap.add_argument("--check", action="store_true", help="preflight only")
    ap.add_argument("--json", action="store_true", help="preflight output as JSON")
    ap.add_argument("--allow-gaps", action="store_true", help="skip incomplete days instead of stopping (exit 3)")
    a = ap.parse_args(argv)

    multi = a.mode == "multi"
    if multi:
        if not a.weight:
            fail("--mode multi needs --weight tau|equal (fixed with the user beforehand)")
        if a.block or a.tradelog:
            fail("--mode multi reads option quotes only; --block / --tradelog are for single mode")
        if a.entry:
            print("note: --entry is ignored in --mode multi (26 entries 09:32 .. 15:45)", file=sys.stderr)
    else:
        if not a.entry:
            fail("--entry HH:MM is required in single mode (fixed with the user beforehand)")
        if not re.fullmatch(r"\d{2}:\d{2}", a.entry):
            fail("--entry must be HH:MM")
        eh, em = map(int, a.entry.split(":"))
        t_min = 16 * 60 - (eh * 60 + em)
        if t_min <= 0:
            fail("--entry must be before 16:00")
        t = t_min / MINUTES_PER_DAY / TRADING_DAYS
    if a.center == "forward" and (a.block or a.tradelog):
        fail("--center forward needs option quotes; Option Omega blocks have no put-call parity forward")
    if a.per_entry and not multi:
        fail("--per-entry is for --mode multi")
    out = a.out or ("vrp_daily_multi.csv" if multi else f"vrp_daily_{a.entry.replace(':', '')}.csv")

    con = open_market(a.market_db, a.underlying)
    data_dir = a.data_dir or os.path.dirname(os.path.abspath(a.market_db))
    if a.trades == "db" and a.tradelog:
        fail("--trades db reads blocks from the database; --tradelog files need --trades csv")
    paths = resolve_tradelogs([] if a.trades == "db" else a.block, a.tradelog, data_dir)
    use_quotes = quote_table_ok(con)
    if use_quotes:
        use_quotes = con.execute("SELECT COUNT(*) FROM market.option_quote_minutes WHERE underlying=?",
                                 [a.underlying]).fetchone()[0] > 0
    if (multi or a.center == "forward" or a.leg) and not use_quotes:
        fail("--mode multi, --center forward and --leg need option quotes in market.option_quote_minutes")
    if multi:
        code = run_multi(a, con, out, compute=not a.check)
        con.close()
        return code
    if not paths and not (a.trades == "db" and a.block) and not use_quotes:
        fail("no IV source: pass --block / --tradelog (0DTE strangles and an ATM straddle at the entry time) "
             "or load option quotes into TradeBlocks. The script does not fetch anything; "
             "market-data provides quotes, oo-capture the Option Omega runs (with the user's consent).")
    bars = bar_stats(con, a.underlying, a.entry, t, a.date_from, a.date_to)
    if a.trades == "db" and a.block:
        oo_days, oo_dates = read_oo_db(con, os.path.join(data_dir, "analytics.duckdb"), a.block, a.underlying,
                                       a.entry, a.date_from, a.date_to, bars)
    else:
        oo_days, oo_dates = read_oo(paths, a.entry, a.date_from, a.date_to) if paths else ({}, set())
    days, items = preflight(con, a.underlying, a.entry, a.date_from, a.date_to, oo_days, oo_dates,
                            use_quotes, t, t_min, bars, a.center)
    print_preflight(days, items, a.entry, a.json)
    if a.check:
        return EXIT_GAPS if items else 0
    if items and not a.allow_gaps:
        print("preflight found gaps: nothing computed (fix them, or use --allow-gaps to skip these days)",
              file=sys.stderr)
        return EXIT_GAPS

    fields = fields_for(a)
    existing = {}
    if os.path.exists(out) and not a.force:
        with open(out, newline="") as fh:
            rd = csv.DictReader(fh)
            if set(fields) <= set(rd.fieldnames or []):          # a file without the requested columns is recomputed
                existing = {r["date"]: r for r in rd if r.get("iv_mf")}
    todo = [d for d, r in days.items() if r["status"] == "ok" and d not in existing]
    ps1 = ps5 = {}
    hist = None
    if todo and (a.rv_freq == "1m" or a.leg or a.range_rv):
        ps1 = path_stats(con, a.underlying, [a.entry], 1, None if a.leg else a.date_from, None if a.leg else a.date_to)
        if a.leg:
            hist = build_hist(ps1).get(a.entry)
    if todo and a.moments and a.rv_freq == "5m":
        ps5 = path_stats(con, a.underlying, [a.entry], 5, a.date_from, a.date_to)
    rows, skipped = list(existing.values()), 0
    for d in todo:
        st = bars[d]
        p1, p5 = ps1.get((d, a.entry)), ps5.get((d, a.entry))
        if a.rv_freq == "1m":
            if not p1:
                skipped += 1
                continue
            st = dict(st, down=p1["down"] / t, up=p1["up"] / t, total=p1["tot"] / t)
        chain = None
        if a.leg and days[d]["source"] == "quotes":
            chain = days[d]["input"].get("chain") or forward_chains(con, a.underlying, d, [a.entry]).get(a.entry)
        ctx = {"ps1": p1, "ps_m": p1 if a.rv_freq == "1m" else p5, "hist": hist, "chain": chain}
        row = day_row(a.underlying, d, a.entry, t_min, t, days[d], a, st, ctx)
        if row is None:
            skipped += 1
            continue
        rows.append(row)
    con.close()
    rows.sort(key=lambda r: r["date"])
    write_csv(out, fields, rows)
    if a.dataset:
        write_csv(a.dataset, dataset_fields_for(a), [r for r in rows if r.get("iv") not in (None, "")])
        print("timing: " + json.dumps(timing_plan(dataset_fields_for(a), "single", a.entry)))
    gap_days = sorted(d for d, r in days.items() if r["status"] != "ok")
    print(f"wrote {out}: {len(rows)} days ({len(todo) - skipped} new, {skipped} without valid RV); "
          f"{len(gap_days)} days skipped by the preflight (incomplete bars, no IV nodes or half-day)"
          + (f"; dataset {a.dataset}" if a.dataset else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
