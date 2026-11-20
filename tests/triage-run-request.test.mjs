import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  readConfig,
  loadScenarios,
  runRequest,
  usesIntraMinuteStops,
} from "../scripts/triage-run-request.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "scripts", "triage-run-request.mjs");

// Synthetic cost scenarios in Option Omega field values (no real values).
const COSTS = {
  scenarios: {
    base: {
      entrySlippage: 0.3,
      exitSlippage: 0,
      stopLossSlippage: 0.6,
      openingFees: 2,
      closingFees: 2,
    },
    stress: {
      entrySlippage: 0.9,
      exitSlippage: 0.1,
      stopLossSlippage: 1.2,
      openingFees: 3,
      closingFees: 3,
    },
  },
};

function setup(costs = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rr-"));
  const costFile = join(dir, "costs.json");
  writeFileSync(costFile, JSON.stringify(COSTS));
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      costs: { file: costFile, base: "base", ...costs },
      verdictLog: "verdicts.jsonl",
      runRoot: "runs",
      plugin: { exists: false },
    }),
  );
  return { dir, configPath, costFile };
}

function settings(overrides = {}) {
  return {
    parameters: {
      underlying: "SPX",
      legs: [
        { type: "Put", buySell: "Sell", daysToExpiration: 0 },
        { type: "Put", buySell: "Buy", daysToExpiration: 0 },
      ],
      exitConditions: [
        {
          maxLoss: 200,
          maxProfit: 50,
          useIntraMinuteStop: true,
          useProfitActions: true,
        },
      ],
      entrySlippage: 0.05,
      exitSlippage: 0.05,
      stopLossSlippage: 0.1,
      openingFees: 0.6,
      closingFees: 0.6,
      entryMinVix: 15,
      entryMaxVix: null,
      useOpeningRangeBreakout: true,
      reentryConditions: [{ x: 1 }],
      maxContractsPerTrade: 2,
      ...overrides,
    },
  };
}

test("author costs off the base: author_base, naive, cost_2x, minute_stop (four runs)", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const out = runRequest(settings(), sc, "X");
  assert.deepEqual(out.flags, {
    author_costs_match_base: false,
    author_uses_intra_minute_stops: true,
  });
  assert.deepEqual(
    out.runs.map((r) => r.role),
    ["author_base", "naive", "cost_2x", "minute_stop"],
  );
  const [ab, naive, c2, ms] = out.runs;
  assert.deepEqual(ab.set, COSTS.scenarios.base);
  // naive: base costs, levers off, fixed size
  assert.equal(naive.set.entrySlippage, 0.3);
  assert.equal(naive.set.entryMinVix, null);
  assert.equal(
    "entryMaxVix" in naive.set,
    false,
    "unset filters are left alone",
  );
  assert.equal(naive.set.useOpeningRangeBreakout, false);
  assert.deepEqual(naive.set.reentryConditions, []);
  assert.equal(
    "maxContractsPerTrade" in naive.set,
    false,
    "unchanged fields are not listed",
  );
  assert.equal(
    runRequest(settings({ maxContractsPerTrade: 0 }), sc, "X").runs[1].set
      .maxContractsPerTrade,
    1,
  );
  assert.equal(naive.exitConditions[0].maxLoss, null);
  assert.equal(naive.exitConditions[0].maxProfit, null);
  assert.equal(naive.exitConditions[0].useProfitActions, false);
  // cost_2x = base slippage x 2, base fees
  assert.deepEqual(c2.set, {
    entrySlippage: 0.6,
    exitSlippage: 0,
    stopLossSlippage: 1.2,
    openingFees: 2,
    closingFees: 2,
  });
  assert.deepEqual(ms.exitConditions, [{ useIntraMinuteStop: false }]);
  // Only real changes: naive's exit group lists no field the author already has.
  assert.equal("isTrailingStopLoss" in naive.exitConditions[0], true);
  const quiet = runRequest(
    settings({
      exitConditions: [
        { maxLoss: 200, isTrailingStopLoss: false, useIntraMinuteStop: true },
      ],
    }),
    sc,
    "X",
  ).runs[1];
  assert.equal("isTrailingStopLoss" in quiet.exitConditions[0], false);
  assert.deepEqual(ms.set, COSTS.scenarios.base);
});

test("author on the base costs: no author_base; roles the manifest has are not requested", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const onBase = settings({ ...COSTS.scenarios.base });
  const out = runRequest(onBase, sc, "X", ["naive"]);
  assert.equal(out.flags.author_costs_match_base, true);
  assert.deepEqual(
    out.runs.map((r) => r.role),
    ["cost_2x", "minute_stop"],
  );
});

test("a named cost2x scenario replaces base x 2", () => {
  const { configPath } = setup({ cost2x: "stress" });
  const sc = loadScenarios(readConfig(configPath));
  const c2 = runRequest(settings(), sc, "X").runs.find(
    (r) => r.role === "cost_2x",
  );
  assert.deepEqual(c2.set, COSTS.scenarios.stress);
});

test("intra-minute stops count only for SPX/SPY with every leg at 0 DTE", () => {
  const p = settings().parameters;
  assert.equal(usesIntraMinuteStops(p), true);
  assert.equal(usesIntraMinuteStops({ ...p, underlying: "QQQ" }), false);
  assert.equal(
    usesIntraMinuteStops({
      ...p,
      legs: [{ daysToExpiration: 0 }, { daysToExpiration: 7 }],
    }),
    false,
  );
  assert.equal(
    usesIntraMinuteStops({
      ...p,
      exitConditions: [{ useIntraMinuteStop: false }],
    }),
    false,
  );
});

test("cost scenarios can come from a command (the user's own converter)", () => {
  const { dir } = setup();
  const configPath = join(dir, "cmd.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      costs: {
        command: [
          process.execPath,
          "-e",
          `process.stdout.write(${JSON.stringify(JSON.stringify(COSTS))})`,
        ],
        base: "base",
      },
    }),
  );
  const sc = loadScenarios(readConfig(configPath));
  assert.deepEqual(sc.base, COSTS.scenarios.base);
});

test("bad config and bad cost files are refused with a named reason", () => {
  assert.throws(() => readConfig(undefined), /^Error: NO_CONFIG/);
  const { dir, costFile } = setup();
  const both = join(dir, "both.json");
  writeFileSync(
    both,
    JSON.stringify({ costs: { file: costFile, command: ["x"], base: "base" } }),
  );
  assert.throws(() => readConfig(both), /^Error: BAD_CONFIG: give exactly one/);
  const missing = join(dir, "missing.json");
  writeFileSync(
    missing,
    JSON.stringify({ costs: { file: costFile, base: "nope" } }),
  );
  assert.throws(
    () => loadScenarios(readConfig(missing)),
    /^Error: BAD_COSTS: scenario "nope" not found/,
  );
  const badFile = join(dir, "bad-costs.json");
  writeFileSync(
    badFile,
    JSON.stringify({ scenarios: { base: { entrySlippage: "0.1" } } }),
  );
  const badCfg = join(dir, "bad.json");
  writeFileSync(
    badCfg,
    JSON.stringify({ costs: { file: badFile, base: "base" } }),
  );
  assert.throws(
    () => loadScenarios(readConfig(badCfg)),
    /^Error: BAD_COSTS: scenario base: entrySlippage/,
  );
});

test("CLI prints the request", () => {
  const { dir, configPath } = setup();
  const s = join(dir, "settings.json");
  writeFileSync(s, JSON.stringify(settings()));
  const out = spawnSync(
    process.execPath,
    [script, "--settings", s, "--author-label", "X"],
    {
      encoding: "utf8",
      env: { ...process.env, TRIAGE_CONFIG: configPath },
    },
  );
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).runs.length, 4);
  const bad = spawnSync(process.execPath, [script, "--settings", s], {
    encoding: "utf8",
    env: { ...process.env, TRIAGE_CONFIG: configPath },
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^USAGE/);
});

test("v2 fix 3: naive switches off every lever not on the keep list (fail closed)", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const s = settings({
    allocationPercentage: 5,
    capProfits: true,
    capLosses: true,
    maxOpenTrades: 3,
    useOpeningRangeBreakoutHighLow: true,
    exitConditions: [
      {
        maxLoss: 200,
        isMaxLossPerLeg: true,
        legExitDeltas: [{ leg: 1, delta: 30 }],
        exitUnderlyingPriceMoveUp: 1.5,
        profitType: "ClosingOrder",
      },
    ],
    someFutureLever: true,
    someFutureMode: "On",
  });
  const naive = runRequest(s, sc, "X").runs.find((r) => r.role === "naive");
  assert.equal(naive.set.allocationPercentage, 0);
  assert.equal(naive.set.capProfits, false);
  assert.equal(naive.set.capLosses, false);
  assert.equal(naive.set.maxOpenTrades, null);
  assert.equal(naive.set.useOpeningRangeBreakoutHighLow, false);
  assert.equal(naive.set.someFutureLever, false);
  const g = naive.exitConditions[0];
  assert.equal(g.isMaxLossPerLeg, false);
  assert.deepEqual(g.legExitDeltas, []);
  assert.equal(g.exitUnderlyingPriceMoveUp, null);
  assert.equal("profitType" in g, false, "unit fields stay");
  // An unknown text field cannot be switched off safely: it is listed for review.
  assert.deepEqual(naive.reviewByHand, ["someFutureMode"]);
  // Entry day/time and structure stay.
  assert.equal("legs" in naive.set, false);
  assert.equal("entryTime" in naive.set, false);
});

test("v2 fix 4: the request carries the sha256 of the cost scenarios it used", () => {
  const { configPath } = setup();
  const out = runRequest(
    settings(),
    loadScenarios(readConfig(configPath)),
    "X",
  );
  assert.match(out.costsSha256, /^[0-9a-f]{64}$/);
  const again = runRequest(
    settings(),
    loadScenarios(readConfig(configPath)),
    "X",
  );
  assert.equal(out.costsSha256, again.costsSha256);
});

test("rev210 R6: missing, null, empty or non-numeric cost fields are refused, never 0", () => {
  for (const bad of [undefined, null, "", "0.1", Number.NaN]) {
    const { dir } = setup();
    const scen = structuredClone(COSTS);
    if (bad === undefined) delete scen.scenarios.base.exitSlippage;
    else scen.scenarios.base.exitSlippage = bad;
    const f = join(dir, "c.json");
    writeFileSync(f, JSON.stringify(scen));
    const cfg = join(dir, "cfg.json");
    writeFileSync(cfg, JSON.stringify({ costs: { file: f, base: "base" } }));
    assert.throws(() => loadScenarios(readConfig(cfg)), /^Error: BAD_COSTS: scenario base: exitSlippage/, String(bad));
  }
});

test("rev210 R6: explicit zeros are named; author settings without a cost field never match the base", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const out = runRequest(settings(), sc, "X");
  // COSTS.scenarios.base has exitSlippage 0 (explicit): named, also in the 2x scenario.
  assert.deepEqual(out.zeroCostFields, ["base.exitSlippage", "cost2x.exitSlippage"]);
  const p = settings({ ...COSTS.scenarios.base }).parameters;
  delete p.closingFees;
  assert.equal(runRequest({ parameters: p }, sc, "X").flags.author_costs_match_base, false);
});

test("rev210 R6: the shipped cost template has every required field and no values", () => {
  const t = JSON.parse(readFileSync(join(here, "..", "skills", "is-this-backtest-lambo-or-lada", "templates", "costs.json"), "utf8"));
  for (const s of Object.values(t.scenarios)) {
    for (const f of ["entrySlippage", "exitSlippage", "stopLossSlippage", "openingFees", "closingFees"]) {
      assert.ok(f in s, f);
      assert.notEqual(typeof s[f], "number", `${f} must not carry a default value`);
    }
  }
});

test("rev214: run ranges for the manifest come from the author's OO settings (every run keeps them)", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const s = settings();
  const p = s.parameters ?? s;
  p.rangeStart = "2022-06-01";
  p.rangeEnd = "2026-11-06";
  const out = runRequest(s, sc, "X");
  const range = { from: "2022-06-01", through: "2026-11-06" };
  assert.deepEqual(out.runRanges, {
    author: range,
    author_base: range,
    naive: range,
    cost_2x: range,
    minute_stop: range,
  });
  delete p.rangeEnd;
  assert.deepEqual(runRequest(s, sc, "X").runRanges, {});
});
