"""Tests of the 2.1 options (variance form, BKM moments, leg, multi mode, weighting, timing).

Synthetic-number unit tests always run. The data tests need your own TradeBlocks parquet market data
(VRP_TEST_DATA=<dir with spot/ and option_quote_minutes/>) and are skipped without it.
Run: python3 -m unittest discover -s scripts"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
import vrp_daily as v  # noqa: E402

DATA = os.environ.get("VRP_TEST_DATA", "")  # directory with the TradeBlocks parquet tables spot/ and option_quote_minutes/
HAVE = os.path.isdir(DATA + "/spot") and os.path.isdir(DATA + "/option_quote_minutes")


def run_main(args):
    buf, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(err):
        try:
            code = v.main(args)
        except SystemExit as e:
            code = e.code
    return code, buf.getvalue()


class DailyAggTest(unittest.TestCase):
    def test_tau_vs_equal(self):
        vals, w = [1.0, 3.0], [100, 300]
        self.assertAlmostEqual(v.daily_agg(vals, w, False, min_valid=2), 2.0)
        self.assertAlmostEqual(v.daily_agg(vals, w, True, min_valid=2), 2.5)

    def test_at_least_20_valid_entries(self):
        w = [1.0] * 26
        self.assertIsNotNone(v.daily_agg([1.0] * 20 + [None] * 6, w, False))
        self.assertIsNone(v.daily_agg([1.0] * 19 + [None] * 7, w, False))
        self.assertIsNone(v.daily_agg([1.0] * 19 + [float("nan")] * 7, w, True))

    def test_timing_plan(self):
        f = ["date", "iv", "rv", "q_var", "p_var", "varp", "iv_down_var", "vrp_sum_var"]
        single = v.timing_plan(f, "single", "09:45")
        self.assertEqual(single["knownBy"], "09:45")
        self.assertEqual(single["open"], ["iv", "q_var", "iv_down_var"])
        self.assertEqual(single["close"], ["rv", "p_var", "varp", "vrp_sum_var"])
        multi = v.timing_plan(f, "multi", None)
        self.assertEqual(multi["open"], [])
        self.assertEqual(len(multi["close"]), 7)

    def test_digits_and_field_groups(self):
        self.assertEqual(v.digits("vrp_sum_var"), 8)
        self.assertEqual(v.digits("skewp"), 4)
        self.assertEqual(v.digits("lnvrp_5m"), 5)
        self.assertIsNone(v.digits("leg_kp"))

    def test_weight_is_required_in_multi(self):
        code, _ = run_main(["--market-db", "/nonexistent.duckdb", "--mode", "multi"])
        self.assertNotEqual(code, 0)

    def test_vectorised_matches_scalar_inversion(self):
        import numpy as np
        s, t = 5000.0, 375 / 390 / 252
        ks = np.array([4800.0, 4900.0, 4990.0, 5010.0, 5100.0, 5200.0])
        for put in (True, False):
            sig = np.array([0.30, 0.22, 0.15, 0.15, 0.18, 0.25])
            price = v.bs_otm(s, ks, sig, t, put)
            got = v.iv_from_price_vec(price, s, ks, t, put)
            ok = ~np.isnan(got)
            self.assertTrue(ok.sum() >= 4)
            self.assertLess(np.abs(got[ok] - sig[ok]).max(), 1e-6)


@unittest.skipUnless(HAVE, "set VRP_TEST_DATA to a TradeBlocks parquet market directory")
class RealDataTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import duckdb
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = os.path.join(cls.tmp.name, "mkt.duckdb")
        con = duckdb.connect(cls.db)
        con.execute("CREATE SCHEMA market")
        for tb, hive in (("spot", True), ("option_quote_minutes", True)):
            con.execute(f"CREATE VIEW market.{tb} AS SELECT * FROM read_parquet('{DATA}/{tb}/**/data.parquet', "
                        f"hive_partitioning=true, union_by_name=true)")
        con.close()
        cls.cache = {}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_csv(self, name, args):
        out = os.path.join(self.tmp.name, name)
        if name not in self.cache:
            code, text = run_main(["--market-db", self.db, "--out", out] + args)
            self.assertEqual(code, 0, text)
            self.cache[name] = (pd.read_csv(out), text)
        return self.cache[name]

    def test_default_output_and_timing(self):
        out, ds = os.path.join(self.tmp.name, "bc.csv"), os.path.join(self.tmp.name, "bc_ds.csv")
        code, text = run_main(["--market-db", self.db, "--entry", "09:45", "--from", "2025-03-03", "--to", "2025-03-14",
                               "--out", out, "--dataset", ds])
        self.assertEqual(code, 0, text)
        self.assertGreater(len(pd.read_csv(out)), 0)
        self.assertGreater(len(pd.read_csv(ds)), 0)
        line = [x for x in text.splitlines() if x.startswith("timing:")][0]
        t = json.loads(line[len("timing:"):])
        self.assertEqual(t["open"], ["iv", "iv_down", "iv_up", "iv_mf"])
        self.assertEqual(t["knownBy"], "09:45")

    def test_variance_identity(self):
        df, _ = self.run_csv("m_eq.csv", ["--mode", "multi", "--weight", "equal", "--center", "forward", "--rv-freq", "1m",
                                          "--sum-var", "--moments", "--per-entry",
                                          os.path.join(self.tmp.name, "pe.csv"), "--from", "2024-03-01", "--to", "2024-03-29"])
        pe = pd.read_csv(os.path.join(self.tmp.name, "pe.csv"))
        dn = pe.iv_down_var - pe.rv_down_var
        up = pe.iv_up_var - pe.rv_up_var
        self.assertLess((pe.vrp_down_var - dn).abs().max(), 2e-8)
        self.assertLess((pe.vrp_sum_var - (dn + up)).abs().max(), 3e-8)
        self.assertLess((pe.vrp_sum_var - (pe.vrp_down_var + pe.vrp_up_var)).abs().max(), 2e-8)



    def test_multi_needs_20_valid_entries(self):
        old = v.MULTI_MIN_VALID
        try:
            v.MULTI_MIN_VALID = 27                      # more than the 26 entries: no day can qualify
            out = os.path.join(self.tmp.name, "short.csv")
            code, text = run_main(["--market-db", self.db, "--mode", "multi", "--weight", "tau", "--from", "2024-03-04",
                                   "--to", "2024-03-05", "--out", out, "--allow-gaps"])
            self.assertEqual(len(pd.read_csv(out)), 0, text)
            self.assertIn("with fewer", text)
        finally:
            v.MULTI_MIN_VALID = old
        df, text = self.run_csv("m_eq2.csv", ["--mode", "multi", "--center", "forward", "--rv-freq", "1m", "--sum-var", "--moments",
                                              "--from", "2024-03-01", "--to", "2024-03-29", "--weight", "equal"])
        self.assertGreaterEqual(df.n_entries.min(), 20)

    def test_timing_flags_multi_and_single(self):
        out, ds = os.path.join(self.tmp.name, "t.csv"), os.path.join(self.tmp.name, "t_ds.csv")
        code, text = run_main(["--market-db", self.db, "--mode", "multi", "--weight", "equal", "--from", "2024-03-04",
                               "--to", "2024-03-05", "--out", out, "--dataset", ds, "--sum-var"])
        self.assertEqual(code, 0, text)
        t = json.loads([x for x in text.splitlines() if x.startswith("timing:")][0][len("timing:"):])
        self.assertEqual(t["open"], [])
        self.assertIn("vrp_sum_var", t["close"])
        code, text = run_main(["--market-db", self.db, "--entry", "09:45", "--from", "2024-03-04", "--to", "2024-03-05",
                               "--out", out, "--dataset", ds, "--sum-var", "--moments"])
        t = json.loads([x for x in text.splitlines() if x.startswith("timing:")][0][len("timing:"):])
        self.assertIn("q_var", t["open"])
        self.assertIn("iv_down_var", t["open"])
        self.assertIn("varp", t["close"])
        self.assertIn("rv_down_var", t["close"])


    def test_range_and_ln(self):
        df, _ = self.run_csv("rl.csv", ["--entry", "09:45", "--range-rv", "--ln", "--from", "2024-03-04", "--to", "2024-03-08"])
        import numpy as np
        self.assertTrue((df.rv_range > 0).all())
        self.assertLess((df.vrp_range - (df.iv - df.rv_range)).abs().max(), 2e-3)
        self.assertLess((df.lnvrp - np.log(df.iv ** 2 / df.rv ** 2)).abs().max(), 1e-3)
        self.assertLess((df.lnvrp_5m - np.log(df.iv ** 2 / df.rv_5m ** 2)).abs().max(), 1e-3)


if __name__ == "__main__":
    unittest.main()
