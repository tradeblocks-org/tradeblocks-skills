// Regression tests for the independent review v1: every false-pass hole and
// every rule change decided after it (Q4 fixed size, Q5 cost basis, Q6 C3 stop).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as verdict from "../scripts/triage-verdict.mjs";
import {
  stressMetrics,
  ruleCalendarArgs,
  c4CoverageArgs,
} from "../scripts/triage-collect.mjs";

const { evaluate, logLine, run } = verdict;
const summaryOf = (report) => verdict.summary(report, thresholds);
const here = dirname(fileURLToPath(import.meta.url));
const thresholdsPath = join(
  here,
  "..",
  "skills",
  "is-this-backtest-lambo-or-lada",
  "thresholds.json",
);
const thresholds = JSON.parse(readFileSync(thresholdsPath, "utf8"));
const fixtures = join(here, "fixtures", "triage");

const FIELDS = [
  "underlying",
  "structure",
  "legs",
  "dte",
  "entry_time",
  "stop",
  "exit",
  "entry_filters",
  "days_traded",
  "reentry",
  "sizing",
  "fills",
  "date_range",
];
const sheet = (status = "n/a", overrides = {}) => ({
  ...Object.fromEntries(FIELDS.map((f) => [f, { value: "x", status }])),
  ...overrides,
});

function passing(overrides = {}) {
  return {
    case: "synthetic",
    runAt: "2026-01-01T00:00:00Z",
    source: null,
    ruleSheet: sheet(),
    runs: { author: "a", naive: "n", cost_2x: "c" },
    authorUsesIntraMinuteStops: false,
    authorCostsMatchBase: true,
    runSizes: { a: 1, n: 1, c: 1, ab: 1, m: 1 },
    zeroCostFields: [],
    c4Coverage: {
      source: "caller",
      A: { from: "2020-01-01", through: "2023-12-31" },
      B: { from: "2020-01-01", through: "2023-12-31" },
    },
    checks: {
      C2: { metrics: { trades: 150, months: 40, distinctContractCounts: 1 } },
      C3: { metrics: { maxYearDteMismatchShare: 0, missingRuleDayShare: 0 } },
      C4: { metrics: { point: 12, ciLow: 3, ciHigh: 21 } },
      C5: {
        metrics: {
          plWithoutBest5: 4000,
          best10Share: 0.2,
          positiveYearShare: 1,
        },
      },
      C6: {
        metrics: { stressPeriodsInRecord: 3, worstStressLossInAvgMonths: 2 },
      },
      C7: { metrics: { cost2xPl: 5000, cost2xKeepShare: 0.8 } },
    },
    ...overrides,
  };
}

test("baseline: the complete passing input continues", () => {
  assert.equal(evaluate(passing(), thresholds).verdict, "continue");
});

// --- P2: the intra-minute flag is required ---------------------------------

test("P2: a missing intra-minute flag is refused, never read as 'no intra-minute stops'", () => {
  const r = passing();
  delete r.authorUsesIntraMinuteStops;
  assert.throws(
    () => evaluate(r, thresholds),
    /^Error: BAD_RESULTS: authorUsesIntraMinuteStops/,
  );
  assert.throws(
    () => evaluate(passing({ authorUsesIntraMinuteStops: "no" }), thresholds),
    /^Error: BAD_RESULTS: authorUsesIntraMinuteStops/,
  );
});

// --- P3/P4: every rule field, no unknown names --------------------------------

test("P3: a missing core field counts as assumed; missing secondary fields are refused", () => {
  const only = { ...sheet("stated") };
  for (const f of ["structure", "legs", "dte", "entry_time", "stop", "exit"])
    delete only[f];
  const report = evaluate(
    passing({ source: { ref: "x", description: "text" }, ruleSheet: only }),
    thresholds,
  );
  assert.equal(report.checks.C1.outcome, "cap");
  assert.deepEqual(report.checks.C1.metrics.assumedCore, [
    "structure",
    "legs",
    "dte",
    "entry_time",
    "stop",
    "exit",
  ]);
  assert.equal(report.verdict, "unclear");

  const noSecondary = sheet("stated");
  delete noSecondary.fills;
  assert.throws(
    () =>
      evaluate(
        passing({
          source: { ref: "x", description: "text" },
          ruleSheet: noSecondary,
        }),
        thresholds,
      ),
    /^Error: BAD_RULE_SHEET: missing secondary fields: fills/,
  );
  assert.throws(
    () => evaluate(passing({ ruleSheet: null }), thresholds),
    /^Error: BAD_RULE_SHEET/,
  );
});

test("P4: a misnamed field is refused instead of silently dropped", () => {
  const s = sheet("stated", {
    stop_loss: { value: "200 %", status: "assumed" },
  });
  delete s.stop;
  const r = passing({
    source: { ref: "x", description: "text" },
    ruleSheet: s,
  });
  assert.throws(
    () => evaluate(r, thresholds),
    /^Error: BAD_RULE_SHEET: unknown fields: stop_loss/,
  );
});

// --- P5: C1 needs a description -----------------------------------------------

test("P5: a source without a description skips C1", () => {
  const r = passing({
    source: { ref: "Channel · Title" },
    ruleSheet: sheet("assumed"),
  });
  const report = evaluate(r, thresholds);
  assert.equal(report.checks.C1.status, "skipped");
  assert.equal(report.verdict, "continue");
  const withText = evaluate(
    passing({
      source: { ref: "x", description: "text" },
      ruleSheet: sheet("assumed"),
    }),
    thresholds,
  );
  assert.equal(withText.checks.C1.outcome, "cap");
});

// --- P9: thresholds are validated -----------------------------------------------

test("P9: a thresholds copy with an unknown operator or outcome is refused", () => {
  const bad = structuredClone(thresholds);
  bad.checks.C2.rules[0].op = "=<";
  assert.throws(
    () => evaluate(passing(), bad),
    /^Error: BAD_THRESHOLDS: C2 rule 0 op/,
  );
  const bad2 = structuredClone(thresholds);
  bad2.checks.C5.rules[1].outcome = "warn";
  assert.throws(
    () => evaluate(passing(), bad2),
    /^Error: BAD_THRESHOLDS: C5 rule 1 outcome/,
  );
  const bad3 = structuredClone(thresholds);
  bad3.checks.C7.rules[1].value = "0.5";
  assert.throws(
    () => evaluate(passing(), bad3),
    /^Error: BAD_THRESHOLDS: C7 rule 1 value/,
  );
});

// --- Q6: a C3 cap stops the triage with unclear ------------------------------

test("Q6: a C3 cap stops the triage with unclear, even when C4 would reject", () => {
  const r = passing();
  r.checks.C3 = {
    metrics: { maxYearDteMismatchShare: 0.4, missingRuleDayShare: 0 },
  };
  r.checks.C4 = { metrics: { point: -5, ciLow: -9, ciHigh: 1 } };
  const report = evaluate(r, thresholds);
  assert.equal(report.verdict, "unclear");
  assert.equal(report.stoppedAt, "C3");
  for (const id of ["C4", "C5", "C6", "C7", "C8"])
    assert.equal(report.checks[id].afterStop, true, id);
  assert.equal(report.checks.C3.afterStop, undefined);
});

// --- Q4: fixed size -------------------------------------------------------------

test("Q4: a contract count per entry that is not constant caps C2", () => {
  const r = passing();
  r.checks.C2 = {
    metrics: { trades: 150, months: 40, distinctContractCounts: 3 },
  };
  const report = evaluate(r, thresholds);
  assert.equal(report.checks.C2.outcome, "cap");
  assert.ok(
    report.checks.C2.triggered.some(
      (t) => t.metric === "distinctContractCounts",
    ),
  );
  assert.equal(report.verdict, "unclear");
});

// --- Q5: cost basis --------------------------------------------------------------

test("Q5: author costs off the base scenario without an author_base run cap the verdict", () => {
  const off = evaluate(passing({ authorCostsMatchBase: false }), thresholds);
  assert.equal(off.verdict, "unclear");
  assert.equal(off.costBasis.status, "not_base");
  assert.ok(off.notTested.some((n) => n.id === "costs"));

  const based = evaluate(
    passing({
      authorCostsMatchBase: false,
      runs: { author: "a", author_base: "ab", naive: "n", cost_2x: "c" },
      exitMix: { author: { Expired: 5 }, authorBase: { Expired: 5 } },
    }),
    thresholds,
  );
  assert.equal(based.verdict, "continue");
  assert.equal(based.costBasis.checkedRun, "ab");

  const r = passing();
  delete r.authorCostsMatchBase;
  assert.throws(
    () => evaluate(r, thresholds),
    /^Error: BAD_RESULTS: authorCostsMatchBase/,
  );
});

// --- R8: the script version is identified by content ------------------------------

test("R8: the log line carries the verdict script's sha256", () => {
  const { report } = run([
    "--results",
    join(fixtures, "A3", "check-results.json"),
    "--thresholds",
    thresholdsPath,
  ]);
  const line = JSON.parse(logLine(report));
  assert.match(line.versions.verdictScriptSha256, /^[0-9a-f]{64}$/);
  assert.match(line.thresholdsSha256, /^[0-9a-f]{64}$/);
});

// --- Collector: C6 and C3 inputs ------------------------------------------------

test("C6: a failed window call makes C6 not run; windows without author trades do not count", () => {
  const windows = [
    { name: "a", result: { trades: 3, netPl: -100 } },
    { name: "b", result: { trades: 0, netPl: 0 } },
    { name: "c", result: null },
  ];
  assert.deepEqual(stressMetrics(windows, 1200, 12), {
    notRun: "stress window c could not be read",
  });
  const ok = stressMetrics(windows.slice(0, 2), 1200, 12);
  assert.equal(ok.metrics.stressPeriodsInRecord, 1);
  assert.equal(ok.metrics.worstStressLossInAvgMonths, 1);
});

test("C3: the rule calendar covers the author's OO range and the entry window", () => {
  const args = ruleCalendarArgs({
    useExactDte: false,
    entryDays: ["Monday"],
    dte: 7,
    entryTime: "09:45",
    additionalEntryTimes: ["10:15", "15:15:00"],
    rangeStart: "2016-01-04",
    rangeEnd: "2018-12-31",
  });
  assert.deepEqual(args.rule, {
    entryWeekdays: [1],
    dte: 7,
    selection: "firstAtLeast",
    entryWindow: { from: "09:45", to: "15:15" },
  });
  assert.deepEqual(args.dateRange, { start: "2016-01-04", end: "2018-12-31" });
});

// --- Fixtures: the named check decides ----------------------------------------------

test("A1-A5: every counted check outcome equals the fixture's expected_checks", () => {
  const cases = readdirSync(fixtures).filter((d) =>
    existsSync(join(fixtures, d, "check-results.json")),
  );
  assert.equal(cases.length, 5);
  for (const id of cases) {
    const m = JSON.parse(
      readFileSync(join(fixtures, id, "triage.json"), "utf8"),
    );
    assert.ok(m.expected_checks, `${id}: expected_checks missing`);
    const { report } = run([
      "--results",
      join(fixtures, id, "check-results.json"),
      "--thresholds",
      thresholdsPath,
    ]);
    const counted = Object.fromEntries(
      Object.entries(report.checks)
        .filter(([, r]) => !r.afterGate && !r.afterStop)
        .map(([k, r]) => [k, r.outcome]),
    );
    assert.deepEqual(counted, m.expected_checks, id);
  }
});

// ---------------------------------------------------------------------------
// Review v2 (round 8)
// ---------------------------------------------------------------------------

test("v2 B1: without author_base off the base costs, C4-C8 are not run and the verdict is never reject", () => {
  const r = passing({ authorCostsMatchBase: false });
  r.checks.C4 = { metrics: { point: -50, ciLow: -90, ciHigh: -10 } };
  r.checks.C7 = { metrics: { cost2xPl: -100, cost2xKeepShare: 0 } };
  const report = evaluate(r, thresholds);
  assert.equal(report.verdict, "unclear");
  for (const id of ["C4", "C5", "C6", "C7", "C8"]) {
    assert.equal(report.checks[id].status, "not_run", id);
    assert.match(report.checks[id].reason, /author_base run missing/, id);
  }
  assert.equal(report.checks.C2.status, "run");
  assert.equal(report.checks.C3.status, "run");
});

test("v2 fix 1: R9 guard also without ciHigh, and for a point below ciLow", () => {
  const below = passing();
  below.checks.C4 = { metrics: { point: 2, ciLow: 3, ciHigh: 9 } };
  let report = evaluate(below, thresholds);
  assert.equal(report.checks.C4.outcome, "cap");
  assert.match(report.checks.C4.unreliable, /excludes its own point estimate/);

  const noHigh = passing();
  noHigh.checks.C4 = { metrics: { point: 5, ciLow: 3 } };
  report = evaluate(noHigh, thresholds);
  assert.equal(report.checks.C4.outcome, "cap");
  assert.match(report.checks.C4.unreliable, /interval bound missing/);
  assert.equal(report.verdict, "unclear");
});

test("v2 fix 2: run labels must be distinct across roles", () => {
  for (const runs of [
    { author: "a", naive: "n", cost_2x: "a" },
    { author: "a", naive: "a", cost_2x: "c" },
    { author: "a", author_base: "a", naive: "n", cost_2x: "c" },
  ]) {
    assert.throws(
      () =>
        evaluate(passing({ runs, authorCostsMatchBase: false }), thresholds),
      /^Error: BAD_RESULTS: run labels must be distinct/,
      JSON.stringify(runs),
    );
  }
});

test("v2 fix 4: the log line carries the cost scenarios' sha256", () => {
  const sha = "a".repeat(64);
  const report = evaluate(passing({ costsSha256: sha }), thresholds);
  assert.equal(JSON.parse(logLine(report)).inputs.costsSha256, sha);
});

// ---------------------------------------------------------------------------
// PRD rev 210 (round 8 addendum): exit mix, fixed size on every run, zero costs
// ---------------------------------------------------------------------------

function based(overrides = {}) {
  return passing({
    authorCostsMatchBase: false,
    runs: { author: "a", author_base: "ab", naive: "n", cost_2x: "c" },
    exitMix: {
      author: { "Profit Target": 60, "Stop Loss": 30, Expired: 10 },
      authorBase: { "Profit Target": 58, "Stop Loss": 32, Expired: 10 },
    },
    ...overrides,
  });
}

test("rev210 MQ2: author_base that trades like the author passes the exit-mix guard", () => {
  const report = evaluate(based(), thresholds);
  assert.equal(report.verdict, "continue");
  assert.equal(report.exitMix.status, "same");
});

test("rev210 MQ2: a changed exit-reason mix after re-costing flags and caps", () => {
  const r = based({
    exitMix: {
      author: { Expired: 10737, "Stop Loss": 4805 },
      authorBase: { Expired: 86, "Profit Target": 10493, "Stop Loss": 4963 },
    },
  });
  const report = evaluate(r, thresholds);
  assert.equal(report.verdict, "unclear");
  assert.equal(report.exitMix.status, "changed");
  assert.ok(report.exitMix.maxShareDiff > 0.6);
  assert.ok(report.notTested.some((n) => n.id === "exitMix"));
  assert.match(summaryOf(report), /re-costing changed the trade path/);
});

test("rev210 MQ2: author_base without exit-reason counts is not checked -> cap", () => {
  const r = based();
  delete r.exitMix;
  const report = evaluate(r, thresholds);
  assert.equal(report.verdict, "unclear");
  assert.equal(report.exitMix.status, "not_run");
});

test("rev210 MQ3: a run a check uses that is not on fixed size makes that check not run", () => {
  const r = passing({ runSizes: { a: 1, n: 3, c: 1 } });
  const report = evaluate(r, thresholds);
  assert.equal(report.checks.C4.status, "not_run");
  assert.match(report.checks.C4.reason, /naive run is not on fixed size/);
  assert.equal(report.checks.C7.status, "run");
  const missing = passing({ runSizes: { a: 1, n: 1 } });
  const r2 = evaluate(missing, thresholds);
  assert.equal(r2.checks.C7.status, "not_run");
  assert.match(
    r2.checks.C7.reason,
    /contract counts of the cost_2x run not read/,
  );
});

test("rev210 R6: an explicit zero slippage in the base scenario is named and caps C7", () => {
  const report = evaluate(
    passing({ zeroCostFields: ["base.exitSlippage"] }),
    thresholds,
  );
  assert.equal(report.checks.C7.outcome, "cap");
  assert.match(
    report.checks.C7.reason,
    /slippage 0 in the base scenario: base.exitSlippage/,
  );
  assert.match(summaryOf(report), /Zero cost fields: base.exitSlippage/);
  assert.throws(
    () => evaluate(passing({ zeroCostFields: undefined }), thresholds),
    /^Error: BAD_RESULTS: zeroCostFields/,
  );
});

// ---------------------------------------------------------------------------
// PRD rev 212 (round 11): C4 coverage from each run's backtest range
// ---------------------------------------------------------------------------

test("rev212: C4 coverage from the checked run's and the naive run's backtest ranges", () => {
  const range = { from: "2022-06-01", through: "2026-11-06" };
  const m = (runs, run_ranges) => ({ runs, run_ranges });
  assert.deepEqual(
    c4CoverageArgs(
      m(
        { author: "a", author_base: "ab", naive: "n" },
        { author: range, author_base: range, naive: range },
      ),
    ),
    { A: range, B: range },
  );
  // Without author_base the author run is the checked run.
  assert.deepEqual(
    c4CoverageArgs(
      m({ author: "a", naive: "n" }, { author: range, naive: range }),
    ),
    { A: range, B: range },
  );
  // The checked run's own range is required; the author's does not stand in.
  assert.equal(
    c4CoverageArgs(
      m(
        { author: "a", author_base: "ab", naive: "n" },
        { author: range, naive: range },
      ),
    ),
    undefined,
  );
  assert.equal(
    c4CoverageArgs(m({ author: "a", naive: "n" }, { author: range })),
    undefined,
  );
  assert.equal(
    c4CoverageArgs(m({ author: "a", naive: "n" }, undefined)),
    undefined,
  );
  // A malformed range is never passed on.
  assert.equal(
    c4CoverageArgs(
      m(
        { author: "a", naive: "n" },
        { author: { from: "2022-06-01" }, naive: range },
      ),
    ),
    undefined,
  );
});

test("rev212: caller coverage is named in the summary and logged", () => {
  const c4Coverage = {
    source: "caller",
    A: { from: "2022-06-01", through: "2026-11-06" },
    B: { from: "2022-06-01", through: "2026-11-06" },
  };
  const report = evaluate(passing({ c4Coverage }), thresholds);
  assert.equal(report.verdict, "continue");
  assert.deepEqual(report.c4Coverage, c4Coverage);
  assert.match(summaryOf(report), /C4 coverage: each run's backtest range/);
  assert.deepEqual(JSON.parse(logLine(report)).c4Coverage, c4Coverage);
});

test("rev212/214: without known ranges the trimmed flat window is shown and caps C4", () => {
  const c4Coverage = {
    source: "heldWindow",
    flatWindowTrimmed: {
      trimmed: true,
      from: "2022-07-05",
      through: "2026-10-30",
      droppedDays: 27,
    },
  };
  const report = evaluate(passing({ c4Coverage }), thresholds);
  assert.equal(report.verdict, "unclear");
  assert.equal(report.checks.C4.outcome, "cap");
  const text = summaryOf(report);
  assert.match(text, /C4 coverage: backtest ranges not known/);
  assert.match(text, /27 edge days/);
});

test("rev212: an unknown coverage source is refused", () => {
  assert.throws(
    () => evaluate(passing({ c4Coverage: { source: "guess" } }), thresholds),
    /^Error: BAD_RESULTS: c4Coverage/,
  );
});

// ---------------------------------------------------------------------------
// PRD rev 214 (round 12, review v3)
// ---------------------------------------------------------------------------

test("rev214 MQ2: no coverage caps C4, so a reject cannot stand on a trimmed window", () => {
  const neg = { C4: { metrics: { point: -5, ciLow: -9, ciHigh: -1 } } };
  for (const c4Coverage of [
    {
      source: "heldWindow",
      flatWindowTrimmed: { trimmed: true, from: "2021-01-04", through: "2023-12-29", droppedDays: 300 },
    },
    {
      source: "heldWindow",
      flatWindowTrimmed: { trimmed: false, from: "2020-01-02", through: "2023-12-29", droppedDays: 0 },
    },
  ]) {
    const r = passing({ c4Coverage });
    r.checks = { ...r.checks, ...neg };
    const report = evaluate(r, thresholds);
    assert.equal(report.checks.C4.status, "run");
    assert.equal(report.checks.C4.outcome, "cap");
    assert.match(report.checks.C4.reason, /no coverage/);
    assert.equal(report.verdict, "unclear");
  }
});

test("rev214 MQ2: C4 coverage not recorded caps C4", () => {
  const r = passing();
  delete r.c4Coverage;
  const report = evaluate(r, thresholds);
  assert.equal(report.checks.C4.outcome, "cap");
  assert.match(report.checks.C4.reason, /coverage not recorded/);
  assert.equal(report.verdict, "unclear");
});

test("rev214 MQ3: a changed exit mix makes C4-C8 not run, never a reject", () => {
  const r = based({
    exitMix: {
      author: { Expired: 10737, "Stop Loss": 4805 },
      authorBase: { Expired: 86, "Profit Target": 10493, "Stop Loss": 4963 },
    },
  });
  r.checks = { ...r.checks, C4: { metrics: { point: -5, ciLow: -9, ciHigh: -1 } } };
  const report = evaluate(r, thresholds);
  for (const id of ["C4", "C5", "C6", "C7"]) {
    assert.equal(report.checks[id].status, "not_run", id);
    assert.match(report.checks[id].reason, /exit mix/);
  }
  assert.equal(report.checks.C2.status, "run");
  assert.equal(report.verdict, "unclear");
});

test("rev214 fix 2: author_base together with authorCostsMatchBase true is refused", () => {
  assert.throws(
    () =>
      evaluate(
        passing({ runs: { author: "a", author_base: "ab", naive: "n", cost_2x: "c" } }),
        thresholds,
      ),
    /^Error: BAD_RESULTS: author_base/,
  );
});

test("rev214 B2: the frozen cases A1-A5 carry each run's range and were collected with coverage", () => {
  for (const id of ["A1", "A2", "A3", "A4", "A5"]) {
    const m = JSON.parse(readFileSync(join(fixtures, id, "triage.json"), "utf8"));
    for (const role of Object.keys(m.runs)) {
      assert.ok(m.run_ranges?.[role]?.from && m.run_ranges[role].through, `${id} ${role}`);
    }
    const r = JSON.parse(readFileSync(join(fixtures, id, "check-results.json"), "utf8"));
    if (r.checks.C4?.metrics) assert.equal(r.c4Coverage?.source, "caller", id);
  }
});
