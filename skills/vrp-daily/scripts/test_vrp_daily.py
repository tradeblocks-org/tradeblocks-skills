"""Unit tests for vrp_daily (run: python3 -m unittest discover -s scripts)."""
import io
import contextlib
import csv
import json
import math
import os
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import vrp_daily as v  # noqa: E402


class VrpDailyTest(unittest.TestCase):
    def test_implied_vol_inverts_black_scholes(self):
        s, k, t, r = 5000.0, 5000.0, 375 / 390 / 252, 0.045
        for sigma in (0.08, 0.15, 0.40):
            price = v.bs_straddle(s, k, t, r, sigma)
            self.assertAlmostEqual(v.implied_vol(price, s, k, t, r), sigma, places=6)

    def test_implied_vol_rejects_impossible_price(self):
        self.assertIsNone(v.implied_vol(0.0, 5000.0, 5000.0, 0.001, 0.0))

    def test_realized_vol_constant_growth_is_zero(self):
        closes = [100 * math.exp(0.0001 * i) for i in range(50)]
        self.assertAlmostEqual(v.realized_vol(closes, 390), 0.0, places=9)

    def test_realized_vol_annualization(self):
        closes = [100.0, 101.0, 100.0, 101.0, 100.0]
        rets = [math.log(b / a) for a, b in zip(closes, closes[1:])]
        mean = sum(rets) / len(rets)
        sd = math.sqrt(sum((x - mean) ** 2 for x in rets) / len(rets))
        self.assertAlmostEqual(v.realized_vol(closes, 390), sd * math.sqrt(390 * 252), places=12)

    def test_parse_legs(self):
        self.assertEqual(v.parse_legs("1 Jun 1 4150 P STO 17.60 | 1 Jun 1 4150 C STO 19.70"),
                         (4150.0, 17.6, 19.7))
        self.assertIsNone(v.parse_legs("1 Jun 1 4150 P STO 17.60 | 1 Jun 1 4155 C STO 19.70"))


S = 5000.0
T = 375 / 390 / 252


def flat_nodes(sig, lo=-0.6, hi=0.5, n=12):
    xn = np.linspace(lo, hi, n)
    return xn, np.full_like(xn, sig)


def lognormal_ref(sig, t):
    """Independent reference: adaptive quadrature in u = ln(K/S) of P/K and C/K."""
    from scipy.integrate import quad
    fd = lambda u: float(v.bs_otm(S, S * math.exp(u), sig, t, True)) / (S * math.exp(u))
    fu = lambda u: float(v.bs_otm(S, S * math.exp(u), sig, t, False)) / (S * math.exp(u))
    return (2 / t * quad(fd, -2, 0, epsabs=1e-14, epsrel=1e-12, limit=200)[0],
            2 / t * quad(fu, 0, 2, epsabs=1e-14, epsrel=1e-12, limit=200)[0])


class ModelFreeTest(unittest.TestCase):
    def test_flat_smile_gives_sigma(self):
        for sig, tm in [(0.15, 375), (0.25, 300), (0.40, 60), (0.8, 30)]:
            t = tm / 390 / 252
            xn, vn = flat_nodes(sig)
            r = v.implied_semivariance(xn, vn, S, t, "flat")
            self.assertAlmostEqual(math.sqrt(r["total"]) / sig, 1.0, delta=2e-3)

    def test_flat_smile_split_matches_lognormal(self):
        for sig, tm in [(0.15, 375), (0.25, 300), (0.40, 60)]:
            t = tm / 390 / 252
            xn, vn = flat_nodes(sig)
            r = v.implied_semivariance(xn, vn, S, t, "flat")
            d, u = lognormal_ref(sig, t)
            self.assertAlmostEqual(r["down"] / d, 1.0, delta=2e-3)
            self.assertAlmostEqual(r["up"] / u, 1.0, delta=2e-3)
            self.assertGreater(r["down"], r["up"])

    def test_wings_ordering(self):
        xn = np.array([-0.5, -0.3, -0.1, 0, 0.1, 0.3])
        vn = np.array([.3, .25, .21, .2, .2, .22])
        tr, fl, sl = (v.implied_semivariance(xn, vn, S, T, w)["total"] for w in v.WINGS)
        self.assertLess(tr, fl)
        self.assertLess(fl, sl)

    def test_grid_converges(self):
        xn = np.array([-0.5, -0.3, -0.1, 0, 0.1, 0.3])
        vn = np.array([.3, .25, .21, .2, .2, .22])
        a = v.implied_semivariance(xn, vn, S, T, "flat", step=0.5)["total"]
        b = v.implied_semivariance(xn, vn, S, T, "flat", step=0.1)["total"]
        self.assertAlmostEqual(a / b, 1.0, delta=1e-4)

    def test_realized_down_plus_up_is_total(self):
        r = np.random.default_rng(0).normal(0, 3e-4, 75)
        q = v.realized_semivariance(r, T)
        self.assertAlmostEqual(q["down"] + q["up"], q["total"], places=12)
        self.assertAlmostEqual(q["total"], float((r ** 2).sum() / T), places=12)

    def test_cboe_filter_drops_beyond_first_zero_bid(self):
        book = {4990: (1.0, 1.2), 4980: (0.5, 0.7), 4970: (0.0, 0.1), 4960: (0.3, 0.4), 5010: (2.0, 2.2)}
        out = v.cboe_filter(book, True, 5000.0)
        self.assertEqual(sorted(out), [4980, 4990])
        self.assertAlmostEqual(out[4990], 1.1)


def make_smile_prices(sig_fn, spot=S, t=T, put_ks=None, call_ks=None):
    """Prices of OTM options from a skewed IV function of x; ATM straddle at 5000."""
    sq = math.sqrt(t)
    puts = {k: float(v.bs_otm(spot, k, sig_fn(math.log(k / spot) / sq), t, True)) for k in put_ks}
    calls = {k: float(v.bs_otm(spot, k, sig_fn(math.log(k / spot) / sq), t, False)) for k in call_ks}
    atm = (spot, float(v.bs_otm(spot, spot, sig_fn(0.0), t, True)), float(v.bs_otm(spot, spot, sig_fn(0.0), t, False)))
    return atm, puts, calls


PUT_KS = [4990, 4985, 4980, 4970, 4960, 4950, 4930]
CALL_KS = [5010, 5015, 5020, 5030, 5040, 5050, 5070]
sig_fn = lambda x: 0.12 - 0.05 * x + 0.1 * x * x


class DbCase(unittest.TestCase):
    """Tiny market.duckdb in the real schema: market.spot bars and market.option_quote_minutes."""

    @classmethod
    def setUpClass(cls):
        try:
            import duckdb
        except ImportError:
            raise unittest.SkipTest("duckdb not installed")
        cls.duckdb = duckdb
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = os.path.join(cls.tmp.name, "market.duckdb")
        con = duckdb.connect(cls.db)
        con.execute("CREATE TABLE market.spot (ticker VARCHAR, date VARCHAR, time VARCHAR, open DOUBLE, close DOUBLE)")
        rng = np.random.default_rng(1)
        for d, full in (("2024-03-04", True), ("2024-03-05", False), ("2024-03-06", True)):
            px = 5000.0
            for m in range(9 * 60 + 30, 16 * 60 + 1):
                if not full and m > 12 * 60:
                    break
                tm = f"{m // 60:02d}:{m % 60:02d}"
                nxt = px * math.exp(rng.normal(0, 4e-4))
                con.execute("INSERT INTO market.spot VALUES ('SPX', ?, ?, ?, ?)", [d, tm, px, nxt])
                px = nxt
        con.execute("CREATE TABLE market.option_quote_minutes (underlying VARCHAR, ticker VARCHAR, date VARCHAR, "
                    "time VARCHAR, bid DOUBLE, ask DOUBLE)")
        atm, puts, calls = make_smile_prices(sig_fn, put_ks=PUT_KS, call_ks=CALL_KS)
        cls.prices = (atm, puts, calls)
        d = "2024-03-04"
        rows = []
        occ = lambda cp, k: f"SPXW240304{cp}{int(k * 1000):08d}"
        for k, p in puts.items():
            rows.append((occ("P", k), p - 0.025, p + 0.025))
        for k, p in calls.items():
            rows.append((occ("C", k), p - 0.025, p + 0.025))
        rows.append((occ("P", 5000), atm[1] - 0.05, atm[1] + 0.05))
        rows.append((occ("C", 5000), atm[2] - 0.05, atm[2] + 0.05))
        for tk, b, a in rows:
            con.execute("INSERT INTO market.option_quote_minutes VALUES ('SPX', ?, ?, '09:45', ?, ?)", [tk, d, b, a])
        con.close()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def tradelog(self, name, days_prices):
        """OO-style trade log with the same prices (strangle legs + straddle) at 09:45."""
        path = os.path.join(self.tmp.name, name)
        con = self.duckdb.connect(self.db, read_only=True)
        spot = con.execute("SELECT open FROM market.spot WHERE date='2024-03-04' AND time='09:45'").fetchone()[0]
        con.close()
        with open(path, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["Date Opened", "Time Opened", "Opening Price", "Legs"])
            for d, (atm, puts, calls) in days_prices.items():
                w.writerow([d, "09:45:00", spot, f"1 Mar 4 {atm[0]:.0f} P STO {atm[1]:.2f} | 1 Mar 4 {atm[0]:.0f} C STO {atm[2]:.2f}"])
                for kp, kc in zip(sorted(puts, reverse=True), sorted(calls)):
                    w.writerow([d, "09:45:00", spot, f"1 Mar 4 {kp} P STO {puts[kp]:.4f} | 1 Mar 4 {kc} C STO {calls[kc]:.4f}"])
        return path

    def run_main(self, args):
        buf, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(err):
            code = v.main(args)
        return code, buf.getvalue()


class QuotesVsOoTest(DbCase):
    def test_quotes_path_equals_oo_path_on_same_prices(self):
        atm, puts, calls = self.prices
        # quotes carry +-0.025 around the mid, so mid == price: both paths see identical nodes
        tl = self.tradelog("oo.csv", {"2024-03-04": (tuple([atm[0], atm[1], atm[2]]), puts, calls)})
        # an OO-only run: db copy without the quote table content
        from shutil import copyfile
        db_oo = os.path.join(self.tmp.name, "oo", "market.duckdb")
        os.makedirs(os.path.dirname(db_oo), exist_ok=True)
        copyfile(self.db, db_oo)
        con = self.duckdb.connect(db_oo)
        con.execute("DELETE FROM market.option_quote_minutes")
        con.close()
        out_q, out_o = (os.path.join(self.tmp.name, f"{n}.csv") for n in ("q", "o"))
        code_q, _ = self.run_main(["--market-db", self.db, "--entry", "09:45", "--from", "2024-03-04",
                                   "--to", "2024-03-04", "--out", out_q, "--force", "--allow-gaps"])
        code_o, _ = self.run_main(["--market-db", db_oo, "--tradelog", tl, "--entry", "09:45", "--from", "2024-03-04",
                                   "--to", "2024-03-04", "--out", out_o, "--force", "--allow-gaps"])
        self.assertEqual((code_q, code_o), (0, 0))
        with open(out_q) as fq, open(out_o) as fo:
            rq, ro = list(csv.DictReader(fq))[0], list(csv.DictReader(fo))[0]
        self.assertEqual((rq["iv_source"], ro["iv_source"]), ("quotes", "oo"))
        for col in ("iv_down", "iv_up", "iv_mf", "rv_down", "rv_up", "vrp_mf", "n_put_nodes", "n_call_nodes"):
            self.assertAlmostEqual(float(rq[col]), float(ro[col]), delta=0.02, msg=col)
        self.assertGreater(float(rq["iv_mf"]), float(rq["iv"]) - 0.5)   # smile adds to the ATM level
        self.assertGreater(float(rq["iv_down"]), float(rq["iv_up"]))      # skew


class SqlParityTest(DbCase):
    """SQL parts equal the plain-Python reference implementations."""

    def test_bar_stats_equal_python_reference(self):
        con = self.duckdb.connect(self.db, read_only=True)
        for entry in ("09:45", "09:32"):
            t_min = 16 * 60 - (int(entry[:2]) * 60 + int(entry[3:]))
            t = t_min / 390 / 252
            st = v.bar_stats(con, "SPX", entry, t, None, None)["2024-03-04"]
            bars = con.execute("SELECT time, close FROM market.spot WHERE ticker='SPX' AND date='2024-03-04' "
                               "AND time>=? AND time<='16:00' ORDER BY time", [entry]).fetchall()
            closes = [c for _, c in bars]
            c5 = [c for tm, c in bars if int(tm[3:5]) % 5 == int(entry[3:5]) % 5]
            rets = [math.log(b / a) for a, b in zip(c5, c5[1:])]
            ref = v.realized_semivariance(rets, t)
            self.assertEqual(st["n_bars"], len(bars))
            self.assertAlmostEqual(st["rv"], v.realized_vol(closes, 390), places=12)
            self.assertAlmostEqual(st["rv_5m"], v.realized_vol(c5, 78), places=12)
            for k in ("down", "up", "total"):
                self.assertAlmostEqual(st[k], ref[k], places=12)
        con.close()

    def test_trades_from_db_equal_trade_log(self):
        atm, puts, calls = self.prices
        tl = self.tradelog("par.csv", {"2024-03-04": (atm, puts, calls)})
        con = self.duckdb.connect(os.path.join(self.tmp.name, "analytics.duckdb"))
        con.execute("CREATE SCHEMA trades")
        con.execute("CREATE TABLE trades.trade_data (block_id VARCHAR, date_opened DATE, time_opened VARCHAR, legs VARCHAR)")
        with open(tl, newline="") as fh:
            for r in csv.DictReader(fh):
                con.execute("INSERT INTO trades.trade_data VALUES ('blk', ?, ?, ?)",
                            [r["Date Opened"], r["Time Opened"], r["Legs"]])
        con.close()
        m = self.duckdb.connect(self.db, read_only=True)
        bars = v.bar_stats(m, "SPX", "09:45", 375 / 390 / 252, None, None)
        days_db, dates_db = v.read_oo_db(m, os.path.join(self.tmp.name, "analytics.duckdb"), ["blk"], "SPX",
                                         "09:45", None, None, bars)
        m.close()
        days_csv, dates_csv = v.read_oo([tl], "09:45", None, None)
        self.assertEqual(dates_db, dates_csv)
        a, b = days_db["2024-03-04"], days_csv["2024-03-04"]
        self.assertEqual(a["atm"], b["atm"])
        self.assertEqual(a["puts"].keys(), b["puts"].keys())
        for k in a["puts"]:
            self.assertAlmostEqual(a["puts"][k], b["puts"][k], places=9)
        for k in a["calls"]:
            self.assertAlmostEqual(a["calls"][k], b["calls"][k], places=9)
        self.assertEqual((a["raw_put"], a["raw_call"]), (len(PUT_KS), len(CALL_KS)))


class PreflightTest(DbCase):
    def test_gaps_reported_and_exit_3(self):
        atm, puts, calls = self.prices
        tl = self.tradelog("gap.csv", {d: (atm, puts, calls) for d in ("2024-03-04", "2024-03-06")})
        out = os.path.join(self.tmp.name, "gap_out.csv")
        # 2024-03-05 has bars only until 12:00 and no strangle nodes
        args = ["--market-db", self.db, "--tradelog", tl, "--entry", "09:32", "--out", out, "--json", "--check"]
        code, text = self.run_main(args)
        self.assertEqual(code, 3)
        rep = json.loads(text)
        kinds = {i["kind"]: i for i in rep["missing"]}
        self.assertIn("iv_nodes", kinds)
        self.assertIn("oo-capture", kinds["iv_nodes"]["fix"])
        self.assertTrue(rep["summary"]["blocking"])
        # compute stops with exit 3 and writes nothing
        code, _ = self.run_main(["--market-db", self.db, "--tradelog", tl, "--entry", "09:32", "--out", out])
        self.assertEqual(code, 3)
        self.assertFalse(os.path.exists(out))

    def test_missing_bars_flagged(self):
        atm, puts, calls = self.prices
        tl = self.tradelog("bars.csv", {d: (atm, puts, calls) for d in ("2024-03-04", "2024-03-07")})
        code, text = self.run_main(["--market-db", self.db, "--tradelog", tl, "--entry", "09:45", "--json", "--check"])
        self.assertEqual(code, 3)
        rep = json.loads(text)
        bars = [i for i in rep["missing"] if i["kind"] == "spx_bars"]
        self.assertTrue(bars and "2024-03-07" in bars[0]["dates"])
        self.assertEqual(bars[0]["fix_skill"], "market-data")


if __name__ == "__main__":
    unittest.main()
