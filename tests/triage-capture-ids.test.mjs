import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluate, logLine, summary } from "../scripts/triage-verdict.mjs";
import { resultsFor } from "../scripts/triage-collect.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skill = join(here, "..", "skills", "is-this-backtest-lambo-or-lada");
const fixtures = join(here, "fixtures", "triage");
const thresholds = JSON.parse(readFileSync(join(skill, "thresholds.json"), "utf8"));

// A run's identity is its capture id; synthetic ids only.
const RUNS = { author: "S-author", naive: "S-naive", cost_2x: "S-cost2x" };
const CAPTURES = { author: "cap-a", naive: "cap-n", cost_2x: "cap-c" };
const RULE_FIELDS = thresholds.checks.C1.weights.coreFields.concat(thresholds.checks.C1.weights.secondaryFields);
function passing(overrides = {}) {
  return {
    case: "synthetic",
    runAt: "2026-01-01T00:00:00Z",
    source: null,
    ruleSheet: Object.fromEntries(RULE_FIELDS.map((f) => [f, { value: "x", status: "n/a" }])),
    runs: RUNS,
    captureIds: CAPTURES,
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

test("captureIds per run role reach the report and the log line; ooRunIds is gone", () => {
  const r = evaluate(passing(), thresholds);
  assert.equal(r.verdict, "continue");
  assert.deepEqual(r.captureIds, CAPTURES);
  const line = JSON.parse(logLine(r));
  assert.deepEqual(line.captureIds, CAPTURES);
  assert.equal("ooRunIds" in line, false);
  assert.equal("ooRunIds" in r, false);
  assert.doesNotMatch(summary(r, thresholds), /capture id/i);
});

test("check results with ooRunIds are refused with a clear message (no silent mapping)", () => {
  assert.throws(
    () => evaluate(passing({ ooRunIds: ["slot1"] }), thresholds),
    /^Error: REMOVED_FIELD: ooRunIds .*captureIds/,
  );
  // Also when captureIds is given next to it.
  assert.throws(() => evaluate(passing({ ooRunIds: [] }), thresholds), /^Error: REMOVED_FIELD: ooRunIds/);
});

test("captureIds is required and names exactly the run roles", () => {
  assert.throws(() => evaluate(passing({ captureIds: undefined }), thresholds), /^Error: BAD_RESULTS: captureIds/);
  assert.throws(() => evaluate(passing({ captureIds: ["cap-a"] }), thresholds), /^Error: BAD_RESULTS: captureIds/);
  const { naive, ...missing } = CAPTURES;
  assert.throws(() => evaluate(passing({ captureIds: missing }), thresholds), /^Error: BAD_RESULTS: captureIds .*naive/);
  assert.throws(
    () => evaluate(passing({ captureIds: { ...CAPTURES, minute_stop: "cap-m" } }), thresholds),
    /^Error: BAD_RESULTS: captureIds .*minute_stop/,
  );
  assert.throws(() => evaluate(passing({ captureIds: { ...CAPTURES, naive: "" } }), thresholds), /^Error: BAD_RESULTS: captureIds/);
  assert.throws(() => evaluate(passing({ captureIds: { ...CAPTURES, naive: 7 } }), thresholds), /^Error: BAD_RESULTS: captureIds/);
});

test("a role without a capture id (CSV import) is null and named in the summary; verdict unchanged", () => {
  const r = evaluate(passing({ captureIds: { ...CAPTURES, naive: null } }), thresholds);
  assert.equal(r.verdict, "continue");
  assert.equal(r.captureIds.naive, null);
  assert.equal(JSON.parse(logLine(r)).captureIds.naive, null);
  assert.match(summary(r, thresholds), /No capture id: naive \(S-naive\)/);
});

test("collector: captureIds from triage.json capture_ids, null for a role without one", () => {
  const manifest = JSON.parse(readFileSync(join(fixtures, "A1", "triage.json"), "utf8"));
  const collected = { checks: {}, runSizes: {} };
  const none = resultsFor("A1", manifest, collected, "x");
  assert.equal("ooRunIds" in none, false);
  assert.deepEqual(none.captureIds, Object.fromEntries(Object.keys(manifest.runs).map((k) => [k, null])));
  const roles = Object.keys(manifest.runs);
  const some = resultsFor("A1", { ...manifest, capture_ids: { [roles[0]]: "cap-0" } }, collected, "x");
  assert.equal(some.captureIds[roles[0]], "cap-0");
  for (const k of roles.slice(1)) assert.equal(some.captureIds[k], null);
});

test("frozen cases A1-A5 carry captureIds (null: synthetic CSV imports) and no ooRunIds", () => {
  for (const id of readdirSync(fixtures)) {
    const r = JSON.parse(readFileSync(join(fixtures, id, "check-results.json"), "utf8"));
    assert.equal("ooRunIds" in r, false, id);
    assert.deepEqual(r.captureIds, Object.fromEntries(Object.keys(r.runs).map((k) => [k, null])), id);
  }
});
