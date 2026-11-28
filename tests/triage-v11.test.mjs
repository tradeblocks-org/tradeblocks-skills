// V1.1 acceptance cases (PRD "V1.1 additions"): C8 start date, C9 stop neighbours,
// the return-basis line and "liquidity at size" under not tested. A10 (no stop) is A3, asserted in A12; reruns (A13) are in the frozen-case loop of triage-verdict.test.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { logLine, run } from "../scripts/triage-verdict.mjs";
import { readConfig, loadScenarios } from "../scripts/triage-config.mjs";
import { runRequest, settingsFiles, strategyAsBuilt } from "../scripts/triage-run-request.mjs";

// One temp folder per test file, removed after the file's tests.
const ROOT = mkdtempSync(join(tmpdir(), "v11-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures", "triage");
const frozen = (id) => run(["--results", join(fixtures, id, "check-results.json")]);

// --- A8, A9: frozen synthetic cases (private generator, fixed seeds, TradeBlocks calls of SKILL.md) ---

test("A8 start-date trap: A3 whose edge sits in the first 12 months -> unclear (C8 cap)", () => {
  const { report, summary } = frozen("A8");
  assert.equal(report.verdict, "unclear");
  assert.equal(report.checks.C8.status, "run");
  assert.equal(report.checks.C8.outcome, "cap");
  assert.equal(report.checks.C8.metrics.laterStarts, 3);
  assert.ok(report.checks.C8.metrics.minLaterStartPl <= 0);
  assert.ok(report.checks.C8.metrics.latestStartAvgMonthShare < 0.5);
  assert.match(summary, /^C8 .*: CAP — /m);
  // PRD C8 / R8: the full record and every later start's net P&L and average month are in the report and the log line.
  const m = report.checks.C8.metrics;
  assert.ok(Math.abs(m.fullPl - 4941.52) < 1e-6);
  assert.deepEqual(m.starts.map((x) => x.startDate), ["2022-12-06", "2023-06-06", "2023-12-06"]);
  assert.ok(Math.abs(m.starts[0].netPl - 2567.56) < 1e-6);
  for (const x of [m, ...m.starts]) assert.equal(typeof x.avgMonthPl, "number");
  assert.ok(Math.abs(m.starts[2].avgMonthPl / m.avgMonthPl - m.latestStartAvgMonthShare) < 1e-12);
  assert.match(logLine(report), /"fullPl":4941\.52/);
  assert.match(logLine(report), /"netPl":2567\.56/);
});

test("A9 stop-fitted: A3 where the stop_tight neighbour loses money -> reject (C9)", () => {
  const { report, summary } = frozen("A9");
  assert.equal(report.verdict, "reject");
  assert.equal(report.light, "red");
  assert.equal(report.checks.C9.outcome, "reject");
  assert.ok(report.checks.C9.metrics.stopTightPl <= 0);
  assert.ok(report.checks.C9.metrics.stopWidePl > 0);
  assert.match(summary, /^C9 .*: REJECT — /m);
});

// --- A11: run request with maxLoss and a profit-action stopLoss ---

const COSTS = { scenarios: { base: { entrySlippage: 0.3, exitSlippage: 0.1, stopLossSlippage: 0.6, openingFees: 2, closingFees: 2 } } };
function scenarios() {
  const dir = mkdtempSync(join(ROOT, "v11-"));
  writeFileSync(join(dir, "costs.json"), JSON.stringify(COSTS));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ costs: { file: join(dir, "costs.json"), base: "base" }, verdictLog: "v.jsonl", runRoot: "runs" }));
  return loadScenarios(readConfig(join(dir, "config.json")));
}
// Author settings on the base costs, 0 DTE SPX (intra-minute offered), a trailing
// maxLoss and a profit action with a stopLoss.
const stopped = (over = {}) => ({
  underlying: "SPX",
  rangeStart: "2022-01-03",
  rangeEnd: "2025-12-31",
  startingFunds: 100000,
  legs: [
    { id: "s", type: "Put", buySell: "Sell", daysToExpiration: 0 },
    { id: "l", type: "Put", buySell: "Buy", daysToExpiration: 0 },
  ],
  exitConditions: [
    {
      id: "g",
      legIds: ["s", "l"],
      maxLoss: 200,
      lossType: "Percentage",
      isTrailingStopLoss: true,
      trailingStopProfitThreshold: 40,
      trailingStopProfitThresholdType: "Percentage",
      maxProfit: 50,
      useIntraMinuteStop: true,
      useProfitActions: true,
      profitActions: [{ profitTarget: 30, stopLoss: 100 }],
    },
  ],
  ...COSTS.scenarios.base,
  allocationPercentage: 0,
  maxContractsPerTrade: 1,
  ignoreMarginRequirements: true,
  ...over,
});

test("A11 run request: stop_tight and stop_wide with maxLoss and the profit-action stopLoss x 0.75 / x 1.25, everything else unchanged (author on base costs = the realistic run)", () => {
  const author = stopped();
  const out = runRequest(author, scenarios(), "X");
  assert.equal(out.flags.author_has_stop, true);
  assert.deepEqual(out.runs.map((r) => r.role), ["author", "naive", "cost_2x", "stop_tight", "stop_wide"]);
  const files = settingsFiles(author, out.runs);
  for (const [role, f] of [["stop_tight", 0.75], ["stop_wide", 1.25]]) {
    const s = files[role];
    const g = s.exitConditions[0];
    assert.equal(g.maxLoss, 200 * f, role);
    assert.equal(g.profitActions[0].stopLoss, 100 * f, role);
    // Same type, unit and intra-minute rule; the trailing threshold and the target are no stop values.
    assert.equal(g.lossType, "Percentage", role);
    assert.equal(g.isTrailingStopLoss, true, role);
    assert.equal(g.useIntraMinuteStop, true, role);
    assert.equal(g.trailingStopProfitThreshold, 40, role);
    assert.equal(g.profitActions[0].profitTarget, 30, role);
    // Everything else is the author's settings.
    const rest = structuredClone(s);
    rest.exitConditions[0].maxLoss = 200;
    rest.exitConditions[0].profitActions[0].stopLoss = 100;
    assert.deepEqual(rest, author, role);
  }
  // The pre-run text names both runs (one ok for every extra run).
  assert.match(out.runs.find((r) => r.role === "stop_tight").why, /0\.75/);
  assert.match(out.runs.find((r) => r.role === "stop_wide").why, /1\.25/);
});

// The neighbour is the realistic run's settings file with only the stop values changed.
function assertMirrors(author, out, checkedRole, timeActions = false) {
  const files = settingsFiles(author, out.runs);
  for (const [role, f] of [["stop_tight", 0.75], ["stop_wide", 1.25]]) {
    const want = structuredClone(files[checkedRole]);
    for (const g of want.exitConditions) {
      if (typeof g.maxLoss === "number") g.maxLoss *= f;
      for (const a of g.profitActions ?? []) if (typeof a.stopLoss === "number") a.stopLoss *= f;
      if (timeActions) for (const a of g.timeActions ?? []) if (typeof a.stopLoss === "number") a.stopLoss *= f;
    }
    assert.deepEqual(files[role], want, `${role} mirrors ${checkedRole}`);
  }
}

test("A11 run request: stop_tight and stop_wide mirror the realistic run exactly (costs, intra-minute), only the stop values change", () => {
  // On the base costs: the realistic run is the author run.
  const author = stopped();
  assertMirrors(author, runRequest(author, scenarios(), "X"), "author");
  // Off the base costs: the realistic run is author_base, so the neighbours carry the base costs.
  const offAuthor = stopped({ entrySlippage: 0.05 });
  const off = runRequest(offAuthor, scenarios(), "X");
  assert.deepEqual(off.runs.map((r) => r.role), ["author", "author_base", "naive", "cost_2x", "stop_tight", "stop_wide"]);
  for (const role of ["stop_tight", "stop_wide"]) assert.equal(off.runs.find((r) => r.role === role).set.entrySlippage, 0.3, role);
  assertMirrors(offAuthor, off, "author_base");
  // Rule sheet states minute stops: the author run goes without intra-minute; on the base costs too
  // author_base runs and the neighbours follow it (intra-minute on).
  const minute = { stop_mode: { value: "minute", status: "stated" } };
  const m = runRequest(author, scenarios(), "X", minute);
  assertMirrors(author, m, "author_base");
  assert.equal(settingsFiles(author, m.runs).stop_tight.exitConditions[0].useIntraMinuteStop, true);
  const mOff = runRequest(offAuthor, scenarios(), "X", minute);
  assertMirrors(offAuthor, mOff, "author_base");
  assert.equal(settingsFiles(offAuthor, mOff.runs).stop_wide.exitConditions[0].useIntraMinuteStop, true);
  // The exact product is sent: 30 x 0.75 = 22.5 (Option Omega takes any number for a stop).
  const odd = stopped({ exitConditions: [{ ...stopped().exitConditions[0], maxLoss: 30 }] });
  assert.equal(settingsFiles(odd, runRequest(odd, scenarios(), "X").runs).stop_tight.exitConditions[0].maxLoss, 22.5);
});

test("A11 run request: no stop -> no neighbours (C9 n/a); later starts and return basis", () => {
  // Without any stop (no maxLoss, no profit-action stopLoss): no neighbour runs.
  const none = stopped({ exitConditions: [{ id: "g", legIds: ["s", "l"], maxProfit: 50, useProfitActions: false }] });
  const out = runRequest(none, scenarios(), "X");
  assert.equal(out.flags.author_has_stop, false);
  assert.deepEqual(out.runs.map((r) => r.role), ["author", "naive", "cost_2x"]);
  // The return basis and the later starts the verdict reads (C8, step 6).
  assert.deepEqual(out.returnBasis, { startingFunds: 100000, allocationPercentage: 0, maxContractsPerTrade: 1, ignoreMarginRequirements: true, startingFundsAssumed: false });
  // rangeStart + 6, 12, 18 months; + 24 leaves less than 24 months.
  assert.deepEqual(out.c8Starts, ["2022-07-03", "2023-01-03", "2023-07-03"]);
});

test("A11 run request: a time action's stopLoss is scaled too; a time-action stop alone counts as a stop (intra-minute stays off)", () => {
  // The only stop is a switched-on time action's stopLoss: C9 runs, Option Omega refuses intra-minute there.
  const timed = stopped({ exitConditions: [{ id: "g", legIds: ["s", "l"], maxProfit: 50, useTimeActions: true, timeActions: [{ dte: 0, time: "12:00:00", stopLoss: 100 }] }] });
  const out = runRequest(timed, scenarios(), "X");
  assert.equal(out.flags.author_has_stop, true);
  assert.deepEqual(out.runs.map((r) => r.role), ["author", "naive", "cost_2x", "stop_tight", "stop_wide"]);
  assertMirrors(timed, out, "author", true);
  const files = settingsFiles(timed, out.runs);
  for (const [role, f] of [["stop_tight", 0.75], ["stop_wide", 1.25]]) {
    const g = files[role].exitConditions[0];
    assert.equal(g.timeActions[0].stopLoss, 100 * f, role);
    assert.equal(g.timeActions[0].time, "12:00:00", role);
    assert.notEqual(g.useIntraMinuteStop, true, role);
  }
  // With maxLoss and a profit-action stopLoss as well: every stop value is scaled.
  const both = stopped({ exitConditions: [{ ...stopped().exitConditions[0], useTimeActions: true, timeActions: [{ dte: 0, time: "14:00:00", stopLoss: 60 }] }] });
  const b = runRequest(both, scenarios(), "X");
  assertMirrors(both, b, "author", true);
  assert.equal(settingsFiles(both, b.runs).stop_tight.exitConditions[0].timeActions[0].stopLoss, 45);
  // strategy-as-built names the scaled time-action stop.
  assert.match(strategyAsBuilt(files.author, {}, out), /^- stop_tight \(C9\): .*time-action stopLoss 75/m);
});

test("C9 stop values: a switched-off profit or time action's stopLoss is neither scaled nor listed", () => {
  const g = { ...stopped().exitConditions[0], useProfitActions: false, profitActions: [{ profitTarget: 30, stopLoss: 50 }], useTimeActions: false, timeActions: [{ dte: 0, time: "12:00:00", stopLoss: 70 }] };
  const author = stopped({ exitConditions: [g] });
  const out = runRequest(author, scenarios(), "X");
  const tight = settingsFiles(author, out.runs).stop_tight.exitConditions[0];
  assert.equal(tight.maxLoss, 150);
  assert.equal(tight.profitActions[0].stopLoss, 50);
  assert.equal(tight.timeActions[0].stopLoss, 70);
  const line = strategyAsBuilt(settingsFiles(author, out.runs).author, {}, out).split("\n").find((l) => l.startsWith("- stop_tight (C9)"));
  assert.match(line, /maxLoss 150/);
  assert.doesNotMatch(line, /action stopLoss/);
});

// --- A12: summary of A3 ---

test("A12 summary of A3: the return-basis line and 'liquidity at size' under not tested; A10: no stop -> C9 n/a", () => {
  const { report, summary } = frozen("A3");
  // A10 (PRD): A3 has no stop, so C9 is n/a, not 'not tested', and the verdict stays continue.
  assert.equal(report.checks.C9.status, "n/a");
  assert.ok(!report.notTested.some((n) => n.id === "C9"), "n/a is not 'not tested'");
  assert.match(summary, /^C9 .*no stop/m);
  const basis = summary.split("\n").find((l) => l.startsWith("Return basis:"));
  assert.ok(basis, "a 'Return basis:' line");
  assert.match(basis, /starting funds \$100,?000/);
  assert.match(basis, /1 contract/);
  assert.match(basis, /margin ignored: yes/);
  assert.match(basis, /compounding: no/);
  assert.match(basis, /all checks use dollars per trade at fixed size/);
  assert.match(basis, /percentage figures depend on (that|this) basis/);
  assert.match(summary, /^Not tested: .*liquidity at size/m);
});

// --- r68 F2 (release review A): the C8 query's rows go into checks.C8.starts unchanged ---

test("r68 F2: rows shaped like the c8Sql output (run_sql gives dates as YYYY-MM-DD strings) feed evaluate unchanged; other keys are refused naming the expected ones", async () => {
  const { cpSync, readFileSync } = await import("node:fs");
  const sql = runRequest({ parameters: { underlying: "SPX", rangeStart: "2022-06-06", rangeEnd: "2025-12-29", startingFunds: 1, entryTime: "10:00:00",
    legs: [{ id: "a", type: "Put", buySell: "Sell", daysToExpiration: 0, metricType: "Delta", delta: 10 }], exitConditions: [] } }, scenarios(), "A8").c8Sql;
  const [dateKey, plKey] = [...sql.matchAll(/ AS "?(\w+)"?(?=[ ,])/g)].map((m) => m[1]);
  assert.match(sql, /strftime\(s\.d, '%Y-%m-%d'\)/);
  const copy = (starts) => {
    const dir = mkdtempSync(join(ROOT, "v11-"));
    cpSync(join(fixtures, "A8"), dir, { recursive: true });
    const cr = JSON.parse(readFileSync(join(dir, "check-results.json"), "utf8"));
    cr.checks.C8.starts = starts(cr.checks.C8.starts);
    writeFileSync(join(dir, "check-results.json"), JSON.stringify(cr));
    return () => run(["--results", join(dir, "check-results.json")]);
  };
  // As run_sql returns them for the query: { [dateKey]: "YYYY-MM-DD", [plKey]: number }.
  const asQueried = copy((s) => s.map((x) => ({ [dateKey]: x.startDate, [plKey]: x.netPl })))();
  assert.deepEqual(asQueried.report.checks.C8, frozen("A8").report.checks.C8);
  // The old column names are refused with a message naming the expected keys.
  assert.throws(copy((s) => s.map((x) => ({ start: x.startDate, pl: x.netPl }))), /^Error: BAD_RESULTS: C8 .*"startDate".*"netPl"/);
});
