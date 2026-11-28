import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { strategyAsBuilt } from "../scripts/triage-run-request.mjs";

import {
  compareExitMix,
  evaluate,
  logLine,
  run,
  summary,
  coreNotStated,
} from "../scripts/triage-verdict.mjs";

// One temp folder per test file, removed after the file's tests.
const ROOT = mkdtempSync(join(tmpdir(), "triage-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "scripts", "triage-verdict.mjs");
const skill = join(here, "..", "skills", "is-this-backtest-lambo-or-lada");
const thresholdsPath = join(skill, "thresholds.json");
const thresholds = JSON.parse(readFileSync(thresholdsPath, "utf8"));
const fixtures = join(here, "fixtures", "triage");
const expected = JSON.parse(readFileSync(join(fixtures, "expected.json"), "utf8"));

const RULE_FIELDS = thresholds.checks.C1.coreFields.concat(thresholds.checks.C1.secondaryFields);
const sheet = (status = "n/a", overrides = {}) => ({
  ...Object.fromEntries(RULE_FIELDS.map((f) => [f, { value: "x", status }])),
  ...overrides,
});
const stated = (value) => ({ value, status: "stated" });
const DESC = "synthetic source text";
const RANGE = { from: "2020-01-01", through: "2023-12-31" };
// rangeStart + 6, 12, 18 months (+ 24 leaves less than 24 months of RANGE).
const C8_STARTS = ["2020-07-01", "2021-01-01", "2021-07-01"];
const HELD = { source: "heldWindow", flatWindowTrimmed: { trimmed: true, from: "2020-02-03", through: "2023-12-29", droppedDays: 30 } };

// cost_2x keeps 4800 / 6000 = 0.8 of the realistic run.
const NET = { author: 6000, author_base: 6000, cost_2x: 4800 };
// Distinct contract counts of one run and its one contract count (run_sql in step 4).
const size = (n = 1, contracts = 1) => ({ n, contracts });
// C6 stress windows inside RANGE with these net P&Ls (stress_test name and dates, get_statistics netPl).
const win = (...pls) => pls.map((netPl, i) => ({ name: `w${i}`, start: "2022-03-01", end: "2022-03-10", netPl }));
// A complete, passing check-results object; tests change one thing at a time.
function passing(overrides = {}) {
  return {
    case: "synthetic",
    runAt: "2026-01-01T00:00:00Z",
    source: null,
    ruleSheet: sheet(),
    runs: { author: "a", naive: "n", cost_2x: "c" },
    captureIds: { author: "cap-a", naive: "cap-n", cost_2x: "cap-c" },
    runSizes: { a: size(), n: size(), c: size(), ab: size() },
    c4Coverage: { source: "caller" },
    // Raw TradeBlocks numbers: get_statistics netPl per role (realistic = author here).
    netPl: { ...NET },
    checks: {
      // 2020-01 .. 2023-04 = 40 calendar months.
      C2: { entries: 150, firstPeriod: "2020-01", lastPeriod: "2023-04" },
      C3: { metrics: { maxYearDteMismatchShare: 0, missingRuleDayShare: 0 } },
      C4: { metrics: { point: 12, ciLow: 3, ciHigh: 21 } },
      C5: { plWithoutBest5: 4000, best10ShareOfTotal: 0.2, positiveYearShare: 1 },
      // Average month 6000 / 40 = 150: the worst window is 2 average months.
      C6: { windowNetPl: win(-300, 100, 50) },
      // V1.1 C8: the realistic run from each later start of the run request (no stop: C9 n/a).
      C8: { starts: C8_STARTS.map((startDate) => ({ startDate, netPl: 4000 })) },
    },
    ...overrides,
  };
}
// The run request as triage-run-request.mjs writes it (synthetic costs).
function request(overrides = {}, flags = {}) {
  return {
    flags: { author_costs_match_base: true, author_without_intra_minute: false, author_has_stop: false, ...flags },
    baseScenario: "b",
    cost2xName: "b x2 slippage",
    costsExample: false,
    costs: COST_VALUES,
    zeroCostFields: [],
    range: RANGE,
    c8Starts: C8_STARTS,
    returnBasis: { startingFunds: 100000, allocationPercentage: 0, maxContractsPerTrade: 1, ignoreMarginRequirements: true },
    runs: [],
    ...overrides,
  };
}
const COST_VALUES = { base: { entrySlippage: 0.1 }, cost2x: { entrySlippage: 0.2 } };
// check-results.json and the run folder's other files, from one test object; the run
// request asks for the test's runs unless it lists its own.
const split = ({ runs, blockId = "b", captureIds = {}, source, ruleSheet, variantsTried = null, ...rest }, rr = request()) => ({
  results: rest,
  folder: {
    runRequest: rr?.runs?.length || !rr ? rr : { ...rr, runs: Object.entries(runs).map(([role, label]) => ({ role, label })) },
    pluginResult: { block_id: blockId, runs: Object.fromEntries(Object.entries(runs).map(([role, label]) => [role, { label, capture_id: captureIds[role] ?? `cap-${role}` }])) },
    ruleSheet: { source, rule_sheet: ruleSheet, variants_tried: variantsTried },
  },
});
const ev = (all = passing(), rr = request(), opts) => {
  const { results, folder } = split(all, rr);
  return evaluate(results, folder, thresholds, opts);
};
// C3 and C4 carry metrics; C2, C5, C6 the raw numbers.
const withCheck = (id, values) => {
  const r = passing();
  const c = r.checks[id];
  r.checks[id] = c.metrics ? { metrics: { ...c.metrics, ...values } } : { ...c, ...values };
  return r;
};
const withNet = (netPl) => passing({ netPl: { ...NET, ...netPl } });
const withC4 = (metrics) => passing({ checks: { ...passing().checks, C4: { metrics } } });
// The author off the base costs, with author_base and its exit mix.
const based = (overrides = {}) =>
  passing({
    runs: { author: "a", author_base: "ab", naive: "n", cost_2x: "c" },
    exitMix: { author: { Expired: 5 }, authorBase: { Expired: 5 } },
    ...overrides,
  });
const offBase = request({}, { author_costs_match_base: false });
// With a stop, so C9 is a cost-dependent check and not n/a.
const offBaseStop = request({}, { author_costs_match_base: false, author_has_stop: true });

// --- outcomes ------------------------------------------------------------------

test("all checks pass -> continue (green)", () => {
  const report = ev();
  assert.equal(report.verdict, "continue");
  assert.equal(report.light, "green");
  assert.equal(report.checks.C1.status, "skipped");
  assert.deepEqual(report.notTested.map((n) => n.id), ["C1"]);
});

test("each cap rule caps the verdict at unclear; each reject rule rejects", () => {
  for (const [id, metrics] of [
    ["C2", { entries: 99 }],
    ["C2", { lastPeriod: "2021-11" }],
    ["C3", { maxYearDteMismatchShare: 0.06 }],
    ["C3", { missingRuleDayShare: 0.051 }],
    ["C4", { ciLow: 0 }],
    ["C5", { best10ShareOfTotal: 0.51 }],
    ["C5", { positiveYearShare: 0.59 }],
    ["C6", { windowNetPl: [] }],
    ["C7", { cost_2x: 2940 }],
  ]) {
    const report = ev(id === "C7" ? withNet(metrics) : withCheck(id, metrics));
    assert.equal(report.checks[id].outcome, "cap", `${id} ${JSON.stringify(metrics)}`);
    assert.equal(report.verdict, "unclear", `${id} ${JSON.stringify(metrics)}`);
  }
  for (const [id, metrics] of [
    ["C4", { point: 0, ciLow: -5, ciHigh: 5 }],
    ["C5", { plWithoutBest5: 0 }],
    ["C6", { windowNetPl: win(-1875, 10) }],
    ["C7", { cost_2x: -1 }],
  ]) {
    const report = ev(id === "C7" ? withNet(metrics) : withCheck(id, metrics));
    assert.equal(report.checks[id].outcome, "reject", id);
    assert.equal(report.verdict, "reject", id);
    assert.equal(report.light, "red");
  }
});

test("boundaries: values exactly at a cap threshold pass", () => {
  assert.equal(ev(withCheck("C3", { maxYearDteMismatchShare: 0.05, missingRuleDayShare: 0.05 })).checks.C3.outcome, "pass");
  assert.equal(ev(withCheck("C2", { entries: 100, lastPeriod: "2021-12" })).verdict, "continue");
});

test("C4 gate reject: later checks are logged but not counted", () => {
  const r = withCheck("C4", { point: -3, ciLow: -9, ciHigh: 2 });
  r.netPl.cost_2x = 600;
  const report = ev(r);
  assert.equal(report.verdict, "reject");
  assert.equal(report.gateFailed, true);
  for (const id of ["C5", "C6", "C7", "C8", "C9"]) assert.equal(report.checks[id].afterGate, true);
  assert.equal(report.checks.C2.afterGate, undefined);
  assert.match(summary(report, thresholds), /C7 .*\[after failed gate, not counted\]/);
});

test("a triggered C3 rule stops with unclear, even when C4 would reject (Q6)", () => {
  const r = withCheck("C3", { maxYearDteMismatchShare: 0.4 });
  r.checks.C4 = { metrics: { point: -3, ciLow: -9, ciHigh: -1 } };
  const report = ev(r);
  assert.equal(report.stoppedAt, "C3");
  assert.equal(report.verdict, "unclear");
  assert.equal(report.gateFailed, false);
  for (const id of ["C4", "C5", "C6", "C7", "C8", "C9"]) assert.equal(report.checks[id].afterStop, true);
  assert.match(summary(report, thresholds), /Stopped at the data check \(step 4\)/);
  assert.match(summary(report, thresholds), /\[after the C3 stop, not counted\]/);
});

test("missing roles never guess: not run -> at most unclear", () => {
  let report = ev(passing({ runs: { author: "a", cost_2x: "c" } }));
  assert.equal(report.checks.C4.reason, "naive run missing");
  assert.equal(report.verdict, "unclear");
  report = ev(passing({ runs: { author: "a" } }));
  assert.equal(report.verdict, "unclear", "author run alone is never continue");
  assert.equal(report.checks.C7.reason, "cost_2x run missing");
  assert.equal(report.verdict, "unclear");
  assert.throws(() => ev(passing({ runs: {} })), /^Error: NO_AUTHOR_RUN/);
});

test("P1: labels and capture ids from plugin-result.json; a label not the run request's, a role it did not ask for, a run without capture id are refused", () => {
  const rr = request({ runs: [{ role: "author", label: "a" }, { role: "naive", label: "n" }, { role: "cost_2x", label: "c" }] });
  assert.equal(ev(passing(), rr).verdict, "continue");
  for (const [all, re] of [
    [passing({ runs: { author: "a", naive: "a", cost_2x: "c" } }), /naive: label "a" is not the run request's "n"/],
    [based(), /author_base: the run request did not ask for this run/],
    [passing({ captureIds: { naive: "" } }), /naive: capture_id \(the run's oo-capture id\) is required/],
  ])
    assert.throws(() => ev(all, rr), new RegExp(`^Error: BAD_PLUGIN_RESULT: ${re.source}`));
  const { results, folder } = split(passing(), rr);
  assert.throws(() => evaluate(results, { ...folder, pluginResult: { runs: {} } }, thresholds), /^Error: BAD_PLUGIN_RESULT: block_id is required/);
});

test("a check without results or with incomplete metrics is not run; a null metric is a part not run", () => {
  const r = passing();
  delete r.checks.C6;
  r.checks.C5 = { plWithoutBest5: 10 };
  r.checks.C2 = { notRun: "get_statistics failed" };
  let report = ev(r);
  assert.equal(report.checks.C6.reason, "no result supplied");
  assert.equal(report.checks.C5.reason, "numbers missing: best10ShareOfTotal, positiveYearShare");
  assert.equal(report.checks.C2.reason, "get_statistics failed");
  assert.equal(report.verdict, "unclear");

  const p = passing({ runs: { author: "a", cost_2x: "c" } });
  p.checks.C3 = {
    metrics: { maxYearDteMismatchShare: 0, missingRuleDayShare: null },
    notRunReason: "missing rule days need the naive run (author uses entry filters)",
  };
  report = ev(p);
  assert.equal(report.checks.C3.status, "partial");
  assert.equal(report.checks.C3.outcome, "cap");
  assert.match(report.checks.C3.reason, /need the naive run/);
  assert.match(summary(report, thresholds), /missingRuleDayShare not run/);
  // A part that could not run does not stop the triage.
  assert.equal(report.stoppedAt, null);
  p.checks.C3.metrics.maxYearDteMismatchShare = "high";
  assert.throws(() => ev(p), /^Error: BAD_RESULTS: metrics must be numbers/);
});

test("C1: the core fields not stated, no score; an assumed or missing core field caps", () => {
  const c1 = thresholds.checks.C1;
  const full = sheet("stated", { reentry: { value: "none", status: "n/a" } });
  assert.deepEqual(coreNotStated(full, c1), { assumedCoreFields: 0, assumedCore: [] });
  const assumedStop = { ...full, stop: { value: "200 %", status: "assumed" } };
  assert.deepEqual(coreNotStated(assumedStop, c1), { assumedCoreFields: 1, assumedCore: ["stop"] });
  // stop_mode is a safe default; days_traded is core.
  assert.deepEqual(coreNotStated({ ...full, stop_mode: { value: "minute", status: "assumed" } }, c1).assumedCore, []);
  assert.deepEqual(coreNotStated({ ...full, days_traded: { value: "Mon", status: "assumed" } }, c1).assumedCore, ["days_traded"]);
  const report = ev(passing({ source: { ref: "x", description: DESC }, ruleSheet: assumedStop }));
  assert.equal(report.checks.C1.outcome, "cap");
  assert.equal(report.verdict, "unclear");
  // A core field missing from the sheet counts as assumed.
  const { dte, ...noDte } = full;
  assert.deepEqual(coreNotStated(noDte, c1).assumedCore, ["dte"]);
  assert.throws(() => ev(passing({ source: { ref: "x", description: DESC }, ruleSheet: { ...full, dte: { value: 7, status: "guess" } } })), /^Error: BAD_RULE_SHEET/);
});

// The summary names fields; there is no score.
const CORE = thresholds.checks.C1.coreFields;
const coreStated = (status = "assumed") => sheet(status, Object.fromEntries(CORE.map((f) => [f, stated("x")])));
const NO_C = /C = \d|[Cc]onfidence/;

test("summary of a description build: the C1 row names its rule (no core field assumed); no defaults line, no C", () => {
  const source = { ref: "x", built_from: "description", description: DESC };
  const report = ev(passing({ source, ruleSheet: coreStated() }));
  assert.equal(report.checks.C1.outcome, "pass");
  const text = summary(report, thresholds);
  assert.match(text, /^C1 Backtest matches its source: PASS — no core field assumed \(cap if any core field is assumed\)$/m);
  assert.doesNotMatch(text, /Every core field stated/);
  assert.doesNotMatch(text, /Defaults used/);
  assert.doesNotMatch(text, NO_C);
  // The verdict log keeps the core fields not stated, no score.
  assert.deepEqual(report.checks.C1.metrics, { assumedCoreFields: 0, assumedCore: [] });
});

test("A4 summary: a saved backtest with a description names the assumed core field, no C", () => {
  const source = { ref: "x", built_from: "saved backtest", description: DESC };
  const report = ev(passing({ source, ruleSheet: { ...coreStated("stated"), stop: { value: "200 %", status: "assumed" } } }));
  assert.equal(report.checks.C1.outcome, "cap");
  const text = summary(report, thresholds);
  assert.match(text, /^C1 Backtest matches its source: CAP — core field assumed: stop \(cap if any core field is assumed\)$/m);
  assert.doesNotMatch(text, NO_C);
  assert.doesNotMatch(text, /Defaults used/);
  const two = ev(passing({ source, ruleSheet: { ...coreStated("stated"), stop: { value: "x", status: "assumed" }, dte: { value: 7, status: "assumed" } } }));
  assert.match(summary(two, thresholds), /^C1 [^\n]*CAP — core fields assumed: dte, stop \(/m);
  const clean = ev(passing({ source, ruleSheet: coreStated("stated") }));
  assert.match(summary(clean, thresholds), /^C1 Backtest matches its source: PASS — no core field assumed \(cap if any core field is assumed\)$/m);
});

test("gap r52: a saved backtest with a description and a core field marked n/a counts it as assumed (C1 cap)", () => {
  const source = { ref: "x", built_from: "saved backtest", description: DESC };
  const report = ev(passing({ source, ruleSheet: { ...coreStated("stated"), stop: { value: null, status: "n/a" } } }));
  assert.equal(report.checks.C1.outcome, "cap");
  assert.equal(report.verdict, "unclear");
  assert.deepEqual(report.checks.C1.metrics.assumedCore, ["stop"]);
  const text = summary(report, thresholds);
  assert.match(text, /^C1 Backtest matches its source: CAP — core field assumed: stop \(cap if any core field is assumed\)$/m);
  // r54 (Review A r53 F2): the rule sheet marks it like any assumed field; a stated one stays unmarked.
  assert.match(text, /^  \* stop: null$/m);
  assert.match(text, /^    dte: /m);
  // strategy-as-built marks it too.
  const built = strategyAsBuilt({ underlying: "SPX", rangeStart: "2025-03-03", rangeEnd: "2025-03-14", startingFunds: 1, entryTime: "10:00:00",
    legs: [{ id: "a", type: "Put", buySell: "Sell", daysToExpiration: 0, metricType: "Delta", delta: 10 }], exitConditions: [] },
  { ...coreStated("stated"), stop: { value: null, status: "n/a" }, reentry: { value: null, status: "n/a" } }, {}, source);
  assert.match(built, /^## Exit \*\(assumed: stop\)\*$/m);
  assert.doesNotMatch(built, /assumed: [^)]*reentry/);
  const { stop, ...noStop } = coreStated("stated");
  assert.match(strategyAsBuilt({ underlying: "SPX", rangeStart: "2025-03-03", rangeEnd: "2025-03-14", startingFunds: 1, entryTime: "10:00:00",
    legs: [{ id: "a", type: "Put", buySell: "Sell", daysToExpiration: 0, metricType: "Delta", delta: 10 }], exitConditions: [] }, noStop, {}, source), /^## Exit \*\(assumed: stop\)\*$/m);
  // A secondary field may be n/a: no cap.
  assert.equal(ev(passing({ source, ruleSheet: { ...coreStated("stated"), reentry: { value: null, status: "n/a" } } })).checks.C1.outcome, "pass");
});

test("rule sheet: a misnamed field or a missing secondary field is refused; no description skips C1", () => {
  assert.throws(() => ev(passing({ ruleSheet: { ...sheet(), colour: stated("red") } })), /^Error: BAD_RULE_SHEET: unknown fields: colour/);
  const { fills, ...noFills } = sheet();
  assert.throws(() => ev(passing({ ruleSheet: noFills })), /^Error: BAD_RULE_SHEET: missing secondary fields: fills/);
  for (const source of [null, { ref: "x" }, { ref: "x", description: " " }]) {
    assert.equal(ev(passing({ source })).checks.C1.status, "skipped", JSON.stringify(source));
  }
  assert.equal(ev(passing({ source: { ref: "x", descriptionSha256: "a".repeat(64) } })).checks.C1.status, "run");
});

// --- thresholds ------------------------------------------------------------------

test("O2: only the shipped thresholds.json: every rule with a metric, a known op and outcome and a number; no --thresholds", () => {
  assert.deepEqual(Object.keys(thresholds.checks), ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9"]);
  for (const [id, def] of Object.entries(thresholds.checks))
    for (const r of def.rules) {
      assert.match(r.metric, /^\w+$/, id);
      assert.ok(["<", "<=", ">", ">="].includes(r.op), `${id} ${r.op}`);
      assert.ok(["cap", "reject"].includes(r.outcome), `${id} ${r.outcome}`);
      assert.ok(Number.isFinite(r.value), `${id} ${r.metric}`);
    }
  assert.ok([">", ">="].includes(thresholds.exitMix.op) && Number.isFinite(thresholds.exitMix.value));
  assert.throws(() => run(["--results", "x.json", "--thresholds", thresholdsPath]), /^Error: USAGE/);
});

test("the TradeBlocks version is recorded when reported, never required", () => {
  for (const versions of [undefined, {}, { tradeblocks: "" }]) assert.equal(ev(passing({ versions })).verdict, "continue");
  assert.equal(ev(passing({ versions: { tradeblocks: "9.9.9" } })).versions.tradeblocks, "9.9.9");
});

// --- costs: base, author_base, exit mix, 2x, example -------------------------------

test("author off the base costs without author_base: C4-C9 not run, never reject", () => {
  const off = ev(withCheck("C5", { plWithoutBest5: -1 }), offBaseStop);
  assert.equal(off.costBasis.status, "not_base");
  assert.equal(off.verdict, "unclear");
  for (const id of ["C4", "C5", "C6", "C7", "C8", "C9"]) assert.equal(off.checks[id].status, "not_run", id);
  const b = ev(based(), offBase);
  assert.equal(b.verdict, "continue");
  assert.equal(b.costBasis.checkedRun, "ab");
});

test("exit mix: same mix passes, a changed mix makes C4-C9 not run, missing counts cap", () => {
  const mix = { author: { "Profit Target": 8, Expired: 2 }, authorBase: { Expired: 10 } };
  const changed = ev({ ...based({ exitMix: mix }), checks: withCheck("C5", { plWithoutBest5: -1 }).checks }, offBaseStop);
  assert.equal(changed.exitMix.status, "changed");
  assert.equal(changed.verdict, "unclear");
  for (const id of ["C4", "C5", "C6", "C7", "C8", "C9"]) assert.equal(changed.checks[id].status, "not_run", id);
  assert.match(summary(changed, thresholds), /Exit mix: re-costing changed the trade path.*C4-C9 not run\./);
  const none = ev(based({ exitMix: undefined }), offBase);
  assert.equal(none.exitMix.status, "not_run");
  assert.equal(none.verdict, "unclear");
});

test("rev248: author without intra-minute, author_base with: only the profit-target and time shares are compared, and the summary says so", () => {
  const minute = request({}, { author_costs_match_base: false, author_without_intra_minute: true });
  // Intra-minute stops move exits from expiry to stop: not a re-costing change.
  const stops = { author: { Expired: 50, "Stop Loss": 20, "Profit Target": 30 }, authorBase: { Expired: 30, "Stop Loss": 40, "Profit Target": 30 } };
  const same = ev(based({ exitMix: stops }), minute);
  assert.equal(same.exitMix.status, "same");
  assert.deepEqual(same.exitMix.compared, ["profit_target", "time"]);
  assert.match(summary(same, thresholds), /author without intra-minute, check runs with/);
  assert.equal(ev(based({ exitMix: stops }), offBase).exitMix.status, "changed", "all classes when the author has intra-minute too");
  const target = { author: { Expired: 50, "Profit Target": 50 }, authorBase: { Expired: 70, "Profit Target": 30 } };
  assert.equal(ev(based({ exitMix: target }), minute).exitMix.status, "changed");
  assert.doesNotMatch(summary(ev(based({ exitMix: target }), offBase), thresholds), /author without intra-minute/);
});

test("exit classes: one 'Backtest Completed' is neutral; 'Conditional'/'Submitted' are not time exits", () => {
  const one = ev(based({ exitMix: { author: { Expired: 5 }, authorBase: { Expired: 4, "Backtest Completed": 1 } } }), offBase);
  assert.equal(one.exitMix.status, "same");
  const two = ev(based({ exitMix: { author: { Expired: 5 }, authorBase: { Expired: 3, "Backtest Completed": 2 } } }), offBase);
  assert.equal(two.exitMix.authorBase.other, 1);
  const counts = { "Conditional exit": 1, "Submitted Exit": 1, Time: 1, "Time Exit": 1, "DIT Exit": 1, MIT: 1, "Max DTE": 1 };
  const { author } = compareExitMix(counts, counts, thresholds.exitMix);
  assert.equal(author.time, 5);
  assert.equal(author.other, 2);
});

test("a run a check uses that is not on fixed size makes that check not run", () => {
  const r = ev(passing({ runSizes: { a: size(), n: size(3, null), c: size() } }));
  assert.equal(r.checks.C4.status, "not_run");
  assert.match(r.checks.C4.reason, /naive run is not on fixed size/);
  assert.equal(ev(passing({ runSizes: { a: size(), n: size() } })).checks.C7.reason, "contract counts of the cost_2x run not read");
});

test("PRD C2: C2's contract-count metric comes from runSizes of the realistic run; a number per label is refused", () => {
  const two = ev(passing({ runSizes: { a: size(2, null), n: size(), c: size() } }));
  assert.equal(two.checks.C2.metrics.distinctContractCounts, 2);
  assert.equal(two.checks.C2.outcome, "cap");
  assert.equal(ev().checks.C2.metrics.distinctContractCounts, 1);
  assert.throws(() => ev(passing({ runSizes: { a: 1, n: 1, c: 1 } })), /^Error: BAD_RESULTS: runSizes/);
});

test("PRD C2: the same contract count on every run a check uses; a naive or cost_2x run at another size is not run", () => {
  const r = ev(passing({ runSizes: { a: size(1, 3), n: size(1, 1), c: size(1, 3) } }));
  assert.equal(r.checks.C4.status, "not_run");
  assert.equal(r.checks.C4.reason, "naive run trades 1 contracts per entry, the realistic run 3");
  assert.equal(r.checks.C7.status, "run");
  const c = ev(passing({ runSizes: { a: size(1, 3), n: size(1, 3), c: size(1, 2) } }));
  assert.equal(c.checks.C7.reason, "cost_2x run trades 2 contracts per entry, the realistic run 3");
  assert.equal(c.verdict, "unclear");
});

test("an explicit zero base slippage caps C7 and is named", () => {
  const report = ev(passing(), request({ zeroCostFields: ["base.exitSlippage"] }));
  assert.equal(report.checks.C7.outcome, "cap");
  assert.match(report.checks.C7.reason, /slippage 0 in the base scenario: base.exitSlippage/);
  assert.match(summary(report, thresholds), /Zero cost fields: base.exitSlippage \(/);
});

test("example costs cap C7 and are named in summary and log; a C7 reject stands (M1)", () => {
  const ex = request({ costsExample: true });
  const r = ev(passing(), ex);
  assert.equal(r.checks.C7.outcome, "cap");
  assert.match(r.checks.C7.reason, /costs: example \(not your own\)/);
  assert.equal(r.verdict, "unclear");
  assert.match(summary(r, thresholds), /costs: example \(not your own\)/);
  assert.equal(JSON.parse(logLine(r)).costsSource, "example (not your own)");
  assert.equal(ev().costsSource, "own");
  const rej = ev(withNet({ cost_2x: -1 }), ex);
  assert.equal(rej.checks.C7.outcome, "reject");
  assert.equal(rej.verdict, "reject");
  assert.match(summary(rej, thresholds), /C7 capped unless it rejects/);
});

test("the run request must be the script's output", () => {
  for (const rr of [null, {}, request({ costsExample: undefined }), request({ zeroCostFields: null }), request({}, { author_costs_match_base: "yes" })]) {
    assert.throws(() => ev(passing(), rr), /^Error: BAD_RUN_REQUEST: /);
  }
});

// --- C4 interval and coverage -------------------------------------------------------

test("R9: an interval that excludes its point or lacks a bound caps C4, never rejects (M2)", () => {
  for (const metrics of [
    { point: 30, ciLow: 1, ciHigh: 20 },
    { point: -1, ciLow: 2, ciHigh: 5 },
    { point: -1, ciLow: null, ciHigh: null },
    { point: -1, ciLow: -3, ciHigh: null },
  ]) {
    const r = ev(withC4(metrics));
    assert.ok(r.checks.C4.unreliable, JSON.stringify(metrics));
    assert.equal(r.checks.C4.outcome, "cap", JSON.stringify(metrics));
    assert.equal(r.gateFailed, false);
  }
  assert.equal(ev(withC4({ point: -1, ciLow: -3, ciHigh: 1 })).verdict, "reject");
});

test("C4 coverage: caller ranges are named; without them C4 is at most cap", () => {
  assert.match(summary(ev(), thresholds), /C4 coverage: both runs' backtest range 2020-01-01 to 2023-12-31;/);
  assert.deepEqual(JSON.parse(logLine(ev())).range, RANGE);
  const reject = { point: -1, ciLow: -3, ciHigh: 1 };
  for (const c4Coverage of [undefined, null, HELD]) {
    const r = ev({ ...withC4(reject), c4Coverage });
    assert.equal(r.checks.C4.outcome, "cap", JSON.stringify(c4Coverage));
    assert.notEqual(r.verdict, "reject");
  }
  assert.match(ev(passing({ c4Coverage: HELD })).checks.C4.reason, /coverage source "heldWindow", not the backtest ranges/);
});

// --- report, log line, summary ---------------------------------------------------------

test("P4: every run's capture id is logged", () => {
  assert.deepEqual(JSON.parse(logLine(ev())).captureIds, passing().captureIds);
});

test("C6 at 99 says the average month is not positive (rule unchanged)", () => {
  const r = ev(withNet({ author: -10, cost_2x: -20 }));
  assert.equal(r.checks.C6.outcome, "reject");
  assert.match(summary(r, thresholds), /^C6 .*worstStressLossInAvgMonths 99 \(average month not positive\)/m);
  assert.doesNotMatch(summary(ev(), thresholds), /average month not positive/);
});

test("P3: the log line is the full report: block, runs, cost names and values, range, checks, versions, hashes; one line", () => {
  const report = ev(passing({ blockId: "b1" }), request(), { thresholdsSha256: "abc" });
  const text = logLine(report);
  const line = JSON.parse(text);
  assert.deepEqual(line, JSON.parse(JSON.stringify(report)));
  assert.equal(line.verdict, "continue");
  assert.equal(line.runAt, "2026-01-01T00:00:00Z");
  assert.equal(line.blockId, "b1");
  assert.deepEqual(line.runs, passing().runs);
  assert.deepEqual(line.costs, { base: "b", cost2x: "b x2 slippage", values: COST_VALUES });
  assert.deepEqual(line.range, RANGE);
  assert.equal(line.thresholdsSha256, "abc");
  assert.equal(line.thresholdsVersion, thresholds.version);
  assert.equal(line.versions.skill, readFileSync(join(skill, "SKILL.md"), "utf8").match(/^  version: "([^"]+)"$/m)[1]);
  assert.match(line.versions.verdictScriptSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(line.checks), ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9"]);
  assert.ok(!text.includes("\n"));
});

test("summary: source first, light, one line per check, rule sheet, not tested, limits", () => {
  const report = ev(
    passing({
      source: { ref: "Channel · Title · 2026-01-01", description: DESC },
      ruleSheet: sheet("stated", { stop: { value: "200 %", status: "assumed" } }),
    }),
  );
  const text = summary(report, thresholds);
  const lines = text.split("\n");
  assert.equal(lines[0], "Source: Channel · Title · 2026-01-01");
  assert.equal(lines[1], "🟡 Verdict: UNCLEAR");
  for (const id of ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9"]) assert.ok(lines.some((l) => l.startsWith(`${id} `)), id);
  assert.match(text, /\* stop: 200 %/);
  // C8 is the V1.1 start-date check; the dropped minute-stop check stays gone.
  assert.doesNotMatch(text, /minute_stop/);
  assert.match(text, /triage is not due diligence/);
  assert.doesNotMatch(text, /robust/i);
  assert.match(summary(ev(), thresholds), /Rule sheet \(from the author run's settings; no source to compare\):/);
});

// --- CLI and the frozen calibration cases -----------------------------------------------

test("S1, P1: runs, block and capture ids come from plugin-result.json, source, rule sheet and variants from rule-sheet.json; copies in the check results are overwritten", () => {
  const { results, folder } = split(passing({ source: { ref: "x", description: DESC }, ruleSheet: sheet("stated"), captureIds: { author: "cap-a" }, variantsTried: 7 }));
  const r = evaluate(results, folder, thresholds);
  assert.deepEqual(r.runs, passing().runs);
  assert.equal(r.blockId, "b");
  assert.equal(r.captureIds.author, "cap-a");
  assert.equal(r.variantsTried, 7);
  assert.equal(r.checks.C1.status, "run");
  assert.deepEqual(evaluate({ ...results, runs: { author: "copied" }, blockId: "copied" }, folder, thresholds).runs, passing().runs);
  assert.throws(() => evaluate(results, { ...folder, pluginResult: null }, thresholds), /^Error: BAD_PLUGIN_RESULT/);
  assert.throws(() => evaluate(results, { ...folder, ruleSheet: null }, thresholds), /^Error: BAD_RULE_SHEET/);
});

test("CLI: reads run-request.json next to the check results, appends one log line per run, writes the summary", () => {
  const dir = mkdtempSync(join(ROOT, "triage-"));
  const results = join(dir, "check-results.json");
  const parts = split(passing());
  writeFileSync(results, JSON.stringify(parts.results));
  const log = join(dir, "verdicts.jsonl");
  const env = { PATH: process.env.PATH };
  const missing = spawnSync(process.execPath, [script, "--results", results], { encoding: "utf8", env });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^BAD_RUN_REQUEST: .*run-request\.json/);
  writeFileSync(join(dir, "run-request.json"), JSON.stringify(parts.folder.runRequest));
  for (const [name, reason, content] of [["plugin-result.json", "BAD_PLUGIN_RESULT", parts.folder.pluginResult], ["rule-sheet.json", "BAD_RULE_SHEET", parts.folder.ruleSheet]]) {
    const before = spawnSync(process.execPath, [script, "--results", results], { encoding: "utf8", env });
    assert.match(before.stderr, new RegExp(`^${reason}: .*${name.replace(".", "\\.")}`));
    writeFileSync(join(dir, name), JSON.stringify(content));
  }
  const out = spawnSync(process.execPath, [script, "--results", results, "--log", log, "--summary", join(dir, "s.md")], { encoding: "utf8", env });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).verdict, "continue");
  spawnSync(process.execPath, [script, "--results", results, "--log", log], { encoding: "utf8", env });
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2);
  assert.ok(existsSync(join(dir, "s.md")));
  const bad = spawnSync(process.execPath, [script, "--results"], { encoding: "utf8", env });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^USAGE:/);
});

const cases = readdirSync(fixtures).filter((d) => existsSync(join(fixtures, d, "check-results.json")));

test("frozen calibration cases A1-A5, A8, A9: expected verdict and counted check outcomes; reruns byte-identical", () => {
  assert.deepEqual(cases.sort(), ["A1", "A2", "A3", "A4", "A5", "A8", "A9"]);
  for (const id of cases) {
    const args = ["--results", join(fixtures, id, "check-results.json")];
    const first = run(args);
    const { report } = first;
    assert.ok(expected[id].verdict.includes(report.verdict), `${id}: ${report.verdict}`);
    const counted = Object.fromEntries(
      Object.entries(report.checks)
        .filter(([, r]) => !r.afterGate && !r.afterStop)
        .map(([k, r]) => [k, r.outcome]),
    );
    assert.deepEqual(counted, expected[id].checks, id);
    if (report.checks.C4.metrics) assert.equal(report.c4Coverage?.source, "caller", id);
    const second = run(args);
    assert.equal(logLine(first.report), logLine(second.report), id);
    assert.equal(first.summary, second.summary, id);
  }
});

test("the rule-sheet template and thresholds name the same rule-sheet fields", () => {
  const fields = [...thresholds.checks.C1.coreFields, ...thresholds.checks.C1.secondaryFields];
  const rs = JSON.parse(readFileSync(join(skill, "templates", "rule-sheet.json"), "utf8"));
  assert.deepEqual(Object.keys(rs.rule_sheet).sort(), [...fields].sort());
});


test("r56 ASK 2: C3's missing rule days must name the run the run request names (blackout days or entry filters: naive)", () => {
  const p = (run) => passing({ checks: { ...passing().checks, C3: { metrics: { maxYearDteMismatchShare: 0, missingRuleDayShare: 0 }, ...(run ? { missingRuleDaysRun: run } : {}) } } });
  const rq = request({ c3MissingDaysRun: "naive" });
  assert.throws(() => ev(p("author"), rq), /^Error: BAD_RESULTS: C3 missingRuleDayShare must be read from the naive run/);
  assert.throws(() => ev(p(), rq), /got null as missingRuleDaysRun/);
  // r57 F2: the refusal names both next steps, so a user without that run is not sent to a run they cannot query.
  assert.throws(() => ev(p("author"), rq), /call get_rule_calendar on that run and name it, or set missingRuleDayShare null with a notRunReason if that run does not exist$/);
  assert.equal(ev(p("naive"), rq).checks.C3.outcome, "pass");
  assert.equal(ev(p("author"), request({ c3MissingDaysRun: "author" })).checks.C3.outcome, "pass");
  // Not run (null): nothing to name.
  const notRun = passing({ runs: { author: "a", cost_2x: "c" } });
  notRun.checks.C3 = { metrics: { maxYearDteMismatchShare: 0, missingRuleDayShare: null }, notRunReason: "missing rule days need the naive run" };
  assert.equal(ev(notRun, rq).checks.C3.status, "partial");
});

test("r63 ASK 1: a record under 30 months has no later start: C8 not run, listed under not tested, no cap", () => {
  const short = request({ range: { from: "2022-01-01", through: "2023-12-31" }, c8Starts: [] });
  for (const C8 of [undefined, { notRun: "no later start" }, { starts: [] }]) {
    const all = passing();
    if (C8) all.checks.C8 = C8;
    else delete all.checks.C8;
    all.checks.C2 = { entries: 150, firstPeriod: "2022-01", lastPeriod: "2023-12" };
    const report = ev(all, short);
    assert.equal(report.verdict, "continue", JSON.stringify(C8));
    assert.equal(report.checks.C8.outcome, "pass");
    assert.match(report.notTested.find((n) => n.id === "C8")?.reason ?? "", /under 30 months/);
    assert.match(summary(report, thresholds), /^C8 [^\n]*under 30 months/m);
  }
});

test("r63 ASK 2 F3: default starting funds are marked assumed in the summary's return-basis line", () => {
  const rb = { startingFunds: 500000, allocationPercentage: 0, maxContractsPerTrade: 1, ignoreMarginRequirements: true };
  const line = (x) => summary(ev(passing(), request({ returnBasis: x })), thresholds).split("\n").find((l) => l.startsWith("Return basis:"));
  assert.match(line({ ...rb, startingFundsAssumed: true }), /starting funds \$500,000 \(assumed\);/);
  assert.match(line({ ...rb, startingFundsAssumed: false }), /starting funds \$500,000;/);
});

test("r64 ASK 1 (#9): a script-written sheet (saved backtest, no description) - C1 skipped, the summary's rule sheet is from the settings", () => {
  const r = ev(passing({ source: { ref: "PCS 10d", built_from: "saved backtest" }, ruleSheet: sheet("n/a") }));
  assert.equal(r.checks.C1.status, "skipped");
  const s = summary(r, thresholds);
  assert.match(s, /^Source: PCS 10d$/m);
  assert.match(s, /Rule sheet \(from the author run's settings; no source to compare\):/);
  assert.doesNotMatch(s, /assumed fields marked/);
});

test("r65 ASK 1: raw TradeBlocks numbers of the blind public run -> the metrics its agent computed by hand (C2 months, C5 null -> 1, C6 99, keep shares 0)", () => {
  // Read from the TradeBlocks block of a blind run (SPX 0DTE put credit spread); realistic run = author_base (author off base costs).
  const netPl = { author: -2215, author_base: -6627.39999999997, naive: -4180.79999999998, cost_2x: -11043.999999999989, stop_tight: -6390.799999999975, stop_wide: -5731.199999999974 };
  const all = based({
    runs: { author: "a", author_base: "ab", naive: "n", cost_2x: "c", stop_tight: "st", stop_wide: "sw" },
    runSizes: { a: size(), ab: size(), n: size(), c: size(), st: size(), sw: size() },
    netPl,
  });
  all.checks.C2 = { entries: 194, firstPeriod: "2024-01", lastPeriod: "2025-12" };
  all.checks.C5 = { plWithoutBest5: -7296.39999999997, best10ShareOfTotal: null, positiveYearShare: 0 };
  all.checks.C6 = { windowNetPl: win(22.59999999999998, -352.8) };
  const r = ev(all, offBaseStop);
  assert.deepEqual(r.checks.C2.metrics, { entries: 194, months: 24, distinctContractCounts: 1 });
  assert.deepEqual(r.checks.C5.metrics, { plWithoutBest5: -7296.39999999997, best10Share: 1, positiveYearShare: 0 });
  assert.deepEqual(r.checks.C6.metrics, { stressPeriodsInRecord: 2, worstStressLossInAvgMonths: 99 });
  assert.deepEqual(r.checks.C7.metrics, { cost2xPl: -11043.999999999989, cost2xKeepShare: 0 });
  assert.deepEqual(r.checks.C9.metrics, { stopTightPl: -6390.799999999975, stopWidePl: -5731.199999999974, stopTightKeepShare: 0, stopWideKeepShare: 0 });
  for (const id of ["C5", "C6", "C7", "C9"]) assert.equal(r.checks[id].outcome, "reject", id);
});

test("r65 ASK 1: keep shares over the realistic run, the worst window in average months, 0 when no window lost", () => {
  const stop = request({}, { author_has_stop: true });
  const all = passing({
    runs: { author: "a", naive: "n", cost_2x: "c", stop_tight: "st", stop_wide: "sw" },
    runSizes: { a: size(), n: size(), c: size(), st: size(), sw: size() },
    netPl: { author: 6000, cost_2x: 4800, stop_tight: 3000, stop_wide: 7200 },
  });
  all.checks.C6 = { windowNetPl: win(100, 0) };
  const r = ev(all, stop);
  assert.deepEqual(r.checks.C9.metrics, { stopTightPl: 3000, stopWidePl: 7200, stopTightKeepShare: 0.5, stopWideKeepShare: 1.2 });
  assert.deepEqual(r.checks.C6.metrics, { stressPeriodsInRecord: 2, worstStressLossInAvgMonths: 0 });
  assert.equal(ev(withCheck("C6", { windowNetPl: win(-450) })).checks.C6.metrics.worstStressLossInAvgMonths, 3);
});

test("r65 ASK 1: the old metric form is refused (no path keeps the formulas with the agent)", () => {
  for (const [id, metrics] of [
    ["C2", { trades: 150, months: 40 }],
    ["C5", { plWithoutBest5: 1, best10Share: 0.2, positiveYearShare: 1 }],
    ["C6", { stressPeriodsInRecord: 3, worstStressLossInAvgMonths: 2 }],
    ["C7", { cost2xPl: 5000, cost2xKeepShare: 0.8 }],
    ["C9", { stopTightPl: 1, stopWidePl: 1, stopTightKeepShare: 1, stopWideKeepShare: 1 }],
  ]) {
    const all = passing();
    all.checks[id] = { metrics };
    assert.throws(() => ev(all), new RegExp(`^Error: BAD_RESULTS: ${id} takes the raw TradeBlocks numbers`), id);
  }
});

test("r65 ASK 1: bad or missing raw numbers fail closed with the next step", () => {
  assert.throws(() => ev(withCheck("C2", { lastPeriod: "Dec 2025" })), /^Error: BAD_RESULTS: C2 firstPeriod and lastPeriod are get_period_returns periods \(YYYY-MM\)/);
  assert.throws(() => ev(withNet({ cost_2x: "4800" })), /^Error: BAD_RESULTS: netPl\.cost_2x must be get_statistics netPl \(a number\)/);
  assert.throws(() => ev(withCheck("C6", { windowNetPl: [-1, null] })), /^Error: BAD_RESULTS: C6 windowNetPl/);
  const r = ev(passing({ netPl: { cost_2x: 4800 } }));
  // Review B r65 #1: C8's full-record P&L is netPl of the realistic run too.
  for (const id of ["C6", "C7", "C8"]) assert.equal(r.checks[id].reason, "net P&L of the realistic run not read (netPl.author)", id);
  assert.equal(ev(passing({ netPl: { author: 6000 } })).checks.C7.reason, "net P&L of the cost_2x run not read (netPl.cost_2x)");
  const noC2 = passing();
  noC2.checks.C2 = { notRun: "get_period_returns failed" };
  assert.equal(ev(noC2).checks.C6.reason, "C2 months not read (C6 counts the worst window in average months)");
});

// --- r66 ASK 1 (Review A r65 F1): a value the agent could not read never shows as measured ---
// A3 with one raw field changed, run through the CLI like the frozen cases.
function a3With(change) {
  const dir = mkdtempSync(join(ROOT, "a3-"));
  for (const f of ["plugin-result.json", "rule-sheet.json", "run-request.json"])
    writeFileSync(join(dir, f), readFileSync(join(fixtures, "A3", f)));
  const results = JSON.parse(readFileSync(join(fixtures, "A3", "check-results.json"), "utf8"));
  change(results.checks);
  writeFileSync(join(dir, "check-results.json"), JSON.stringify(results));
  return run(["--results", join(dir, "check-results.json")]);
}

test("r66 ASK 1 (a): C5 best10ShareOfTotal null with a notRunReason is not read, never 100 %; null without a reason stays 1", () => {
  const { report, summary: text } = a3With((c) => Object.assign(c.C5, { best10ShareOfTotal: null, notRunReason: "topDays n: 10 not returned" }));
  assert.equal(report.checks.C5.metrics.best10Share, null);
  assert.equal(report.checks.C5.reason, "topDays n: 10 not returned");
  assert.ok(report.notTested.some((n) => n.id === "C5" && n.reason === "topDays n: 10 not returned"));
  assert.doesNotMatch(text, /best10Share 100\.0 %/);
  assert.match(text, /best10Share not run/);
  const returned = a3With((c) => Object.assign(c.C5, { best10ShareOfTotal: null }));
  assert.equal(returned.report.checks.C5.metrics.best10Share, 1);
});

test("r66 ASK 1 (b): a supplied notRunReason on C2, C5 or C6 reaches the report", () => {
  const c5 = a3With((c) => Object.assign(c.C5, { plWithoutBest5: null, notRunReason: "topDays not offered" }));
  assert.equal(c5.report.checks.C5.reason, "topDays not offered");
  const c2 = a3With((c) => Object.assign(c.C2, { entries: null, notRunReason: "trade count not read" }));
  assert.equal(c2.report.checks.C2.reason, "trade count not read");
  const c6 = a3With((c) => (c.C6 = { windowNetPl: null, notRunReason: "stress_test failed" }));
  assert.equal(c6.report.checks.C6.status, "not_run");
  assert.equal(c6.report.checks.C6.reason, "stress_test failed");
});

test("r66 ASK 1 (c): C2 firstPeriod null with a notRunReason is not run (C6 then has no months); a malformed period stays BAD_RESULTS", () => {
  const { report } = a3With((c) => Object.assign(c.C2, { firstPeriod: null, notRunReason: "get_period_returns failed" }));
  assert.equal(report.checks.C2.status, "not_run");
  assert.equal(report.checks.C2.reason, "get_period_returns failed");
  assert.equal(report.checks.C6.reason, "C2 months not read (C6 counts the worst window in average months)");
  assert.throws(() => a3With((c) => (c.C2.firstPeriod = "June 2022")), /BAD_RESULTS: C2 firstPeriod and lastPeriod/);
  // Null without a reason: the message names how to go on.
  assert.throws(() => a3With((c) => (c.C2.firstPeriod = null)), /BAD_RESULTS: C2 .*notRunReason/);
});

// --- r67 ASK 1: author without intra-minute on the base costs -> author_base is the realistic run ---
test("r67 ASK 1: costs match, author without intra-minute -> checks read author_base; summary line and exit-mix guard as before; author_base missing -> not base", () => {
  const minute = request({}, { author_costs_match_base: true, author_without_intra_minute: true });
  const stops = { author: { Expired: 50, "Stop Loss": 20, "Profit Target": 30 }, authorBase: { Expired: 30, "Stop Loss": 40, "Profit Target": 30 } };
  const r = ev(based({ exitMix: stops, netPl: { ...NET, author: -999999 } }), minute);
  assert.equal(r.costBasis.status, "base");
  assert.equal(r.costBasis.checkedRun, "ab");
  assert.equal(r.verdict, "continue", "the numbers come from author_base, not the author run");
  assert.deepEqual(r.exitMix.compared, ["profit_target", "time"]);
  assert.match(summary(r, thresholds), /author without intra-minute, check runs with/);
  const missing = ev(passing(), minute);
  assert.equal(missing.costBasis.status, "not_base");
  assert.match(missing.costBasis.reason, /intra-minute/);
  assert.equal(missing.verdict, "unclear");
});

// --- round 69: private blind run ---

function a3Results(change) {
  const dir = mkdtempSync(join(ROOT, "a3-"));
  for (const f of ["plugin-result.json", "rule-sheet.json", "run-request.json"])
    writeFileSync(join(dir, f), readFileSync(join(fixtures, "A3", f)));
  const results = JSON.parse(readFileSync(join(fixtures, "A3", "check-results.json"), "utf8"));
  change(results);
  writeFileSync(join(dir, "check-results.json"), JSON.stringify(results));
  return run(["--results", join(dir, "check-results.json")]);
}

test("r69 #8: C5 best10ShareOfTotal null (total not positive) prints n/a with the reason, never 100 %; the metric and its cap are unchanged", () => {
  const { report, summary: text } = a3With((c) => Object.assign(c.C5, { best10ShareOfTotal: null }));
  assert.equal(report.checks.C5.metrics.best10Share, 1);
  assert.equal(report.checks.C5.outcome, "cap");
  assert.doesNotMatch(text, /best10Share 100\.0 %/);
  assert.match(text, /^C5 .*best10Share n\/a \(total not positive, counted above the cap\) \(cap if > 50\.0 %\)/m);
});

test("r69 #9: the gate's hint to trade the naive version only when the gate rejects and the naive run made money", () => {
  const gate = (naive) => a3Results((r) => { Object.assign(r.checks.C4.metrics, { point: -3, ciLow: -30, ciHigh: 20 }); r.netPl.naive = naive; });
  const won = gate(1234.5);
  assert.equal(won.report.gateFailed, true);
  assert.match(won.summary, /^C4 .*\n {2}Hint: the naive version made 1234\.50 USD; trade it instead of this strategy\.$/m);
  for (const naive of [-6768, 0]) assert.doesNotMatch(gate(naive).summary, /Hint:|trade the naive/, String(naive));
  assert.doesNotMatch(a3Results(() => {}).summary, /Hint:/, "no gate failure, no hint");
});

// --- round 70: private blind run method decisions ---

// The blind run (SPX iron condor, one exit group per side): author off base costs and without intra-minute stops.
const blind = () => {
  const all = based({
    runs: { author: "a", author_base: "ab", naive: "n", cost_2x: "c", stop_tight: "st", stop_wide: "sw" },
    runSizes: Object.fromEntries(["a", "ab", "n", "c", "st", "sw"].map((l) => [l, { ...size(), entries: 535 }])),
    netPl: { author: 18102, author_base: -9790.800000000027, naive: -6768.000000000242, cost_2x: -28915.200000000357, stop_tight: -8986.400000000018, stop_wide: -4497.399999999904 },
    exitMix: { author: { "Stop Loss": 275, Expired: 795 }, authorBase: { "Stop Loss": 349, Expired: 721 } },
  });
  all.checks.C2 = { entries: 535, firstPeriod: "2022-06", lastPeriod: "2025-12" };
  all.checks.C6 = { windowNetPl: [
    { name: "bear_2022", start: "2022-01-03", end: "2022-10-12", netPl: 1408.799999999999 },
    { name: "svb_crisis", start: "2023-03-08", end: "2023-03-15", netPl: 596.2 },
    { name: "vix_aug_2024", start: "2024-08-01", end: "2024-08-15", netPl: -46.19999999999989 },
    { name: "liberation_day", start: "2025-04-02", end: "2025-04-08", netPl: -1233.8 },
  ] };
  return all;
};
const blindRequest = () => request({ range: { from: "2022-06-01", through: "2025-12-31" } }, { author_costs_match_base: false, author_without_intra_minute: true, author_has_stop: true });

test("r70 ASK 1: C2 counts entries (distinct open date and time), not Option Omega trades; the old trades key is refused naming entries", () => {
  const r = ev(blind(), blindRequest());
  assert.equal(r.checks.C2.metrics.entries, 535);
  assert.equal(r.checks.C2.outcome, "pass");
  assert.match(summary(r, thresholds), /^C2 .*entries 535 \(cap if < 100\)/m);
  // A 60-entry condor logged per side (120 trades) is capped.
  const small = blind();
  small.checks.C2.entries = 60;
  for (const l of Object.keys(small.runSizes)) small.runSizes[l].entries = 60;
  assert.equal(ev(small, blindRequest()).checks.C2.outcome, "cap");
  const old = blind();
  old.checks.C2 = { trades: 1070, firstPeriod: "2022-06", lastPeriod: "2025-12" };
  assert.throws(() => ev(old, blindRequest()), /^Error: BAD_RESULTS: C2 .*entries/);
  // C2 entries must be the runSizes entries of the realistic run.
  const copied = blind();
  copied.checks.C2.entries = 1070;
  assert.throws(() => ev(copied, blindRequest()), /^Error: BAD_RESULTS: C2 entries 1070 .*535/);
});

test("r70 ASK 2: exit mix with no profit-target or time exits on either run is not compared, without a cap; the summary says so", () => {
  const r = ev(blind(), blindRequest());
  assert.equal(r.exitMix.status, "not_compared");
  assert.equal(r.exitMix.reason, "no profit-target or time exits to compare");
  assert.match(summary(r, thresholds), /^Exit mix: not compared: no profit-target or time exits to compare\.$/m);
  for (const id of ["C4", "C5", "C6", "C7", "C9"]) assert.notEqual(r.checks[id].status, "not_run", id);
  assert.ok(!r.notTested.some((n) => n.id === "exitMix"));
  // One profit-target exit on one run: compared as before.
  const one = blind();
  one.exitMix.author["Profit Target"] = 1;
  assert.equal(ev(one, blindRequest()).exitMix.status, "same");
});

test("r70 ASK 3: C6 counts only stress windows fully inside the record's range; a clipped window is listed once as outside the record", () => {
  const r = ev(blind(), blindRequest());
  assert.equal(r.checks.C6.metrics.stressPeriodsInRecord, 3);
  assert.deepEqual(r.checks.C6.windowsOutside, [{ name: "bear_2022", start: "2022-01-03", end: "2022-10-12" }]);
  assert.equal(r.checks.C6.metrics.worstStressLossInAvgMonths, 99, "average month of the realistic run not positive");
  const text = summary(r, thresholds);
  assert.equal(text.match(/bear_2022/g).length, 1);
  assert.match(text, /^C6 .*\n {2}Outside the record, not counted: bear_2022 \(2022-01-03 to 2022-10-12\)\.$/m);
  // A window ending after the record is outside too; boundaries on the range days count.
  const all = passing();
  all.checks.C6.windowNetPl = [
    { name: "first", start: "2020-01-01", end: "2020-01-10", netPl: -300 },
    { name: "late", start: "2023-12-20", end: "2024-01-05", netPl: -9000 },
    { name: "last", start: "2023-12-01", end: "2023-12-31", netPl: 50 },
  ];
  const b = ev(all);
  assert.deepEqual(b.checks.C6.metrics, { stressPeriodsInRecord: 2, worstStressLossInAvgMonths: 2 });
  assert.deepEqual(b.checks.C6.windowsOutside.map((x) => x.name), ["late"]);
  // Only windows outside: no stress period in the record (cap).
  all.checks.C6.windowNetPl = [{ name: "late", start: "2023-12-20", end: "2024-01-05", netPl: -9000 }];
  assert.equal(ev(all).checks.C6.outcome, "cap");
  // The old number form and malformed windows are refused with the shape.
  for (const w of [[-300, 100], [{ name: "x", start: "2020-01-01", netPl: 1 }], [{ name: "x", start: "Jan 2020", end: "2020-02-01", netPl: 1 }]]) {
    all.checks.C6.windowNetPl = w;
    assert.throws(() => ev(all), /^Error: BAD_RESULTS: C6 windowNetPl .*\{ name, start, end, netPl \}/, JSON.stringify(w));
  }
});

test("r70 ASK 4: the C4 hint wording follows the decision (naive net P&L positive)", () => {
  const all = blind();
  all.checks.C4 = { metrics: { point: -3, ciLow: -30, ciHigh: -1 } };
  const r = ev(all, blindRequest());
  assert.equal(r.gateFailed, true);
  assert.equal(r.checks.C4.hint, undefined, "naive -6,768 USD: no hint");
});
