import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  COST_FIELDS,
  defaultConfigPath,
  exampleSha256,
  readConfig,
  loadScenarios,
  resolveConfig,
  setup,
} from "../scripts/triage-config.mjs";
import { main as runRequestMain } from "../scripts/triage-run-request.mjs";
import { evaluate, logLine, summary } from "../scripts/triage-verdict.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skill = join(here, "..", "skills", "is-this-backtest-lambo-or-lada");
const examplePath = join(skill, "templates", "costs-example.json");
const exportScript = join(here, "..", "scripts", "triage-costs-example.mjs");
const thresholds = JSON.parse(readFileSync(join(skill, "thresholds.json"), "utf8"));

// Synthetic values only.
const OWN = { entrySlippage: 0.3, exitSlippage: 0.1, stopLossSlippage: 0.6, openingFees: 2, closingFees: 2 };
const SETTINGS = {
  parameters: {
    underlying: "SPX",
    legs: [{ type: "Put", buySell: "Sell", daysToExpiration: 0 }],
    exitConditions: [{ useIntraMinuteStop: false }],
    ...OWN,
    rangeStart: "2024-01-02",
    rangeEnd: "2024-06-28",
  },
};
const tmp = () => mkdtempSync(join(tmpdir(), "ce-"));
const write = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
  return p;
};
const keys = (r) => (r.ask ?? []).map((a) => a.key);
const example = () => JSON.parse(readFileSync(examplePath, "utf8"));

// --- the shipped example file ----------------------------------------------

test("costs-example.json: labelled, complete, and matches its own sha256", () => {
  const e = example();
  assert.match(e.source, /\S/);
  assert.match(e.exportedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(e.description, /example/i);
  assert.deepEqual(Object.keys(e.scenarios), ["example"]);
  for (const f of COST_FIELDS) assert.equal(typeof e.scenarios.example[f], "number", f);
  assert.equal(e.sha256, exampleSha256(e.scenarios.example));
});

test("costs-example.json carries no private path or file name", () => {
  const text = readFileSync(examplePath, "utf8");
  assert.doesNotMatch(text, /\/home\/|costs_options|\.ya?ml|lenovo/i);
});

// --- maintainer export -------------------------------------------------------

test("export writes the example from one scenario of a cost source, with date and sha256", () => {
  const dir = tmp();
  const src = write(
    join(dir, "private", "print.mjs"),
    `process.stdout.write(JSON.stringify({ scenarios: { mine: ${JSON.stringify(OWN)}, other: {} } }));`,
  );
  const out = join(dir, "costs-example.json");
  const r = spawnSync(
    process.execPath,
    [exportScript, "--scenario", "mine", "--out", out, "--date", "2026-01-02", "--command", process.execPath, src],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  const e = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(e.scenarios, { example: OWN });
  assert.equal(e.exportedAt, "2026-01-02");
  assert.equal(e.sha256, exampleSha256(OWN));
  // The source scenario name and the private path never reach the public file.
  const text = readFileSync(out, "utf8");
  assert.doesNotMatch(text, /mine|private|print\.mjs/);
  // A scenario with a missing field is refused, nothing written.
  const bad = join(dir, "bad.json");
  const r2 = spawnSync(
    process.execPath,
    [exportScript, "--scenario", "other", "--out", bad, "--command", process.execPath, src],
    { encoding: "utf8" },
  );
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /^BAD_COSTS/);
  assert.equal(existsSync(bad), false);
});

// --- first-run setup -----------------------------------------------------------

test("setup asks first whether an own cost file exists", () => {
  const r = setup({}, { HOME: tmp() });
  assert.equal(r.status, "ask");
  assert.deepEqual(keys(r).sort(), ["ownCosts", "plugin"]);
});

test("own costs: yes -> asks where they are and the base scenario name", () => {
  const r = setup({ ownCosts: true, plugin: { exists: false } }, { HOME: tmp() });
  assert.deepEqual(keys(r).sort(), ["base", "costs.source"]);
});

test("own costs: no -> shows the example values and asks for explicit confirmation; nothing written", () => {
  const home = tmp();
  const r = setup({ ownCosts: false, plugin: { exists: false } }, { HOME: home });
  assert.deepEqual(keys(r), ["exampleConfirmed"]);
  const q = r.ask[0];
  assert.deepEqual(q.values, example().scenarios.example);
  assert.match(q.question, /not your own/);
  assert.equal(existsSync(defaultConfigPath({ HOME: home })), false);
});

test("example declined -> own costs are needed", () => {
  const r = setup({ ownCosts: false, exampleConfirmed: false, plugin: { exists: false } }, { HOME: tmp() });
  assert.deepEqual(keys(r).sort(), ["base", "costs.source"]);
});

test("example confirmed -> config records the confirmation; costs load from the shipped example", () => {
  const home = tmp();
  const r = setup({ ownCosts: false, exampleConfirmed: true, plugin: { exists: false } }, { HOME: home });
  assert.equal(r.status, "written", JSON.stringify(r));
  assert.equal(r.costsExample, true);
  const raw = JSON.parse(readFileSync(defaultConfigPath({ HOME: home }), "utf8"));
  assert.equal(raw.costs.base, "example");
  assert.equal(raw.costs.file, null);
  assert.equal(raw.costs.command, null);
  assert.equal(raw.costs.example.sha256, example().sha256);
  assert.match(raw.costs.example.confirmedAt, /^\d{4}-\d{2}-\d{2}T/);
  // No cost value is copied into the config.
  assert.equal(JSON.stringify(raw).includes("stopLossSlippage"), false);
  const sc = loadScenarios(readConfig(defaultConfigPath({ HOME: home })));
  assert.equal(sc.example, true);
  assert.deepEqual(sc.base, example().scenarios.example);
  assert.equal(resolveConfig({ HOME: home }).status, "ready");
});

test("example without a recorded confirmation is refused", () => {
  const dir = tmp();
  const cfg = write(join(dir, "local-config.json"), {
    costs: { file: null, command: null, base: "example", example: {} },
    verdictLog: "v.jsonl",
    runRoot: "r",
    plugin: { exists: false },
  });
  assert.throws(() => readConfig(cfg), /^Error: BAD_CONFIG: costs\.example .*not confirmed/);
});

test("example values that changed since the confirmation are refused", () => {
  const dir = tmp();
  const cfg = write(join(dir, "local-config.json"), {
    costs: { file: null, command: null, base: "example", example: { confirmedAt: "2026-01-01T00:00:00Z", sha256: "0".repeat(64) } },
    verdictLog: "v.jsonl",
    runRoot: "r",
    plugin: { exists: false },
  });
  assert.throws(() => loadScenarios(readConfig(cfg)), /^Error: EXAMPLE_CHANGED: /);
});

// --- run request, verdict, summary, log ------------------------------------------

test("run request names the example costs (costsExample) and own costs as false", () => {
  const home = tmp();
  setup({ ownCosts: false, exampleConfirmed: true, plugin: { exists: false } }, { HOME: home });
  const s = write(join(home, "settings.json"), SETTINGS);
  assert.equal(runRequestMain(["--settings", s, "--author-label", "X"], { HOME: home }).costsExample, true);
  const own = tmp();
  setup({ costs: { source: "new", scenarios: { b: OWN } }, base: "b", plugin: { exists: false } }, { HOME: own });
  const s2 = write(join(own, "settings.json"), SETTINGS);
  assert.equal(runRequestMain(["--settings", s2, "--author-label", "X"], { HOME: own }).costsExample, false);
});

const RULE_FIELDS = thresholds.checks.C1.weights.coreFields.concat(thresholds.checks.C1.weights.secondaryFields);
function passing(overrides = {}) {
  return {
    case: "synthetic",
    runAt: "2026-01-01T00:00:00Z",
    source: null,
    ruleSheet: Object.fromEntries(RULE_FIELDS.map((f) => [f, { value: "x", status: "n/a" }])),
    runs: { author: "S-author", naive: "S-naive", cost_2x: "S-cost2x" },
    authorUsesIntraMinuteStops: false,
    authorCostsMatchBase: true,
    runSizes: { "S-author": 1, "S-naive": 1, "S-cost2x": 1 },
    zeroCostFields: [],
    costsExample: false,
    c4Coverage: { source: "caller", A: { from: "2020-01-01", through: "2023-12-31" }, B: { from: "2020-01-01", through: "2023-12-31" } },
    checks: {
      C2: { metrics: { trades: 150, months: 40, distinctContractCounts: 1 } },
      C3: { metrics: { maxYearDteMismatchShare: 0, missingRuleDayShare: 0 } },
      C4: { metrics: { point: 12, ciLow: 3, ciHigh: 21 } },
      C5: { metrics: { plWithoutBest5: 4000, best10Share: 0.2, positiveYearShare: 1 } },
      C6: { metrics: { stressPeriodsInRecord: 3, worstStressLossInAvgMonths: 2 } },
      C7: { metrics: { cost2xPl: 5000, cost2xKeepShare: 0.8 } },
    },
    ...overrides,
  };
}

test("verdict: example costs cap C7 with the reason, and summary and log say so", () => {
  const own = evaluate(passing(), thresholds);
  assert.equal(own.verdict, "continue");
  assert.equal(own.costsSource, "own");
  const r = evaluate(passing({ costsExample: true }), thresholds);
  assert.equal(r.checks.C7.outcome, "cap");
  assert.match(r.checks.C7.reason, /costs: example \(not your own\)/);
  assert.equal(r.verdict, "unclear");
  assert.equal(r.costsSource, "example (not your own)");
  assert.match(summary(r, thresholds), /costs: example \(not your own\)/);
  assert.equal(JSON.parse(logLine(r)).costsSource, "example (not your own)");
  // A C7 reject on example costs stays a reject.
  const rej = evaluate(passing({ costsExample: true, checks: { ...passing().checks, C7: { metrics: { cost2xPl: -1, cost2xKeepShare: 0 } } } }), thresholds);
  assert.equal(rej.checks.C7.outcome, "reject");
});

test("verdict: costsExample is required (from the run request)", () => {
  assert.throws(() => evaluate(passing({ costsExample: undefined }), thresholds), /^Error: BAD_RESULTS: costsExample/);
});
