import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  evaluate,
  logLine,
  summary,
  translationConfidence,
  run,
} from "../scripts/triage-verdict.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "scripts", "triage-verdict.mjs");
const thresholdsPath = join(
  here,
  "..",
  "skills",
  "is-this-backtest-lambo-or-lada",
  "thresholds.json",
);
const thresholds = JSON.parse(readFileSync(thresholdsPath, "utf8"));
const fixtures = join(here, "fixtures", "triage");

const RULE_FIELDS = thresholds.checks.C1.weights.coreFields.concat(
  thresholds.checks.C1.weights.secondaryFields,
);
const naSheet = () =>
  Object.fromEntries(
    RULE_FIELDS.map((f) => [f, { value: "x", status: "n/a" }]),
  );
const DESC = "synthetic source text";

// A complete, passing check-results object; tests change one thing at a time.
function passing(overrides = {}) {
  return {
    case: "synthetic",
    runAt: "2026-01-01T00:00:00Z",
    source: null,
    ruleSheet: naSheet(),
    runs: { author: "S-author", naive: "S-naive", cost_2x: "S-cost2x" },
    authorUsesIntraMinuteStops: false,
    authorCostsMatchBase: true,
    runSizes: { "S-author": 1, "S-naive": 1, "S-cost2x": 1, "S-minute": 1 },
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

function withCheck(id, metrics) {
  const r = passing();
  r.checks[id] = { metrics: { ...r.checks[id].metrics, ...metrics } };
  return r;
}

const stated = (value) => ({ value, status: "stated" });
const fullSheet = {
  underlying: stated("SPX"),
  structure: stated("put credit spread"),
  legs: stated("20 delta, 50 wide"),
  dte: stated(7),
  entry_time: stated("09:35"),
  stop: stated("none"),
  exit: stated("expiry"),
  entry_filters: stated("none"),
  days_traded: stated("Monday"),
  reentry: { value: "none", status: "n/a" },
  sizing: { value: "1", status: "n/a" },
  fills: { value: "x", status: "n/a" },
  date_range: { value: "x", status: "n/a" },
};

test("all checks pass -> continue (green)", () => {
  const report = evaluate(passing(), thresholds);
  assert.equal(report.verdict, "continue");
  assert.equal(report.light, "green");
  assert.equal(report.checks.C1.status, "skipped");
  assert.equal(report.checks.C8.status, "not_applicable");
  assert.deepEqual(
    report.notTested.map((n) => n.id),
    ["C1", "C8"],
  );
});

test("each cap rule caps the verdict at unclear", () => {
  const caps = [
    ["C2", { trades: 99 }],
    ["C2", { months: 23 }],
    ["C3", { maxYearDteMismatchShare: 0.06 }],
    ["C3", { missingRuleDayShare: 0.051 }],
    ["C4", { ciLow: 0 }],
    ["C5", { best10Share: 0.51 }],
    ["C5", { positiveYearShare: 0.59 }],
    ["C6", { stressPeriodsInRecord: 0 }],
    ["C7", { cost2xKeepShare: 0.49 }],
  ];
  for (const [id, metrics] of caps) {
    const report = evaluate(withCheck(id, metrics), thresholds);
    assert.equal(
      report.checks[id].outcome,
      "cap",
      `${id} ${JSON.stringify(metrics)}`,
    );
    assert.equal(report.verdict, "unclear", `${id} ${JSON.stringify(metrics)}`);
  }
});

test("each reject rule rejects", () => {
  const rejects = [
    ["C4", { point: 0, ciLow: -5, ciHigh: 5 }],
    ["C5", { plWithoutBest5: 0 }],
    ["C6", { worstStressLossInAvgMonths: 12.5 }],
    ["C7", { cost2xPl: -1 }],
  ];
  for (const [id, metrics] of rejects) {
    const report = evaluate(withCheck(id, metrics), thresholds);
    assert.equal(report.checks[id].outcome, "reject", id);
    assert.equal(report.verdict, "reject", id);
    assert.equal(report.light, "red");
  }
});

test("boundaries: values exactly at a cap threshold pass", () => {
  const report = evaluate(
    withCheck("C3", {
      maxYearDteMismatchShare: 0.05,
      missingRuleDayShare: 0.05,
    }),
    thresholds,
  );
  assert.equal(report.checks.C3.outcome, "pass");
  assert.equal(
    evaluate(withCheck("C2", { trades: 100, months: 24 }), thresholds).verdict,
    "continue",
  );
});

test("C4 gate reject: later checks are logged but not counted", () => {
  const r = withCheck("C4", { point: -3, ciLow: -9, ciHigh: 2 });
  r.checks.C7 = { metrics: { cost2xPl: 100, cost2xKeepShare: 0.1 } };
  const report = evaluate(r, thresholds);
  assert.equal(report.verdict, "reject");
  assert.equal(report.gateFailed, true);
  for (const id of ["C5", "C6", "C7", "C8"])
    assert.equal(report.checks[id].afterGate, true);
  assert.equal(report.checks.C2.afterGate, undefined);
  assert.match(
    summary(report, thresholds),
    /C7 .*\[after failed gate, not counted\]/,
  );
});

test("missing roles never guess: not run -> at most unclear", () => {
  const noNaive = passing({
    runs: { author: "S-author", cost_2x: "S-cost2x" },
  });
  let report = evaluate(noNaive, thresholds);
  assert.equal(report.checks.C4.status, "not_run");
  assert.equal(report.checks.C4.reason, "naive run missing");
  assert.equal(report.verdict, "unclear");

  const authorOnly = passing({ runs: { author: "S-author" } });
  report = evaluate(authorOnly, thresholds);
  assert.equal(report.verdict, "unclear", "author run alone is never continue");
  assert.equal(report.checks.C7.reason, "cost_2x run missing");

  const intraMinute = passing({ authorUsesIntraMinuteStops: true });
  report = evaluate(intraMinute, thresholds);
  assert.equal(report.checks.C8.status, "not_run");
  assert.equal(report.checks.C8.reason, "minute_stop run missing");
  assert.equal(report.verdict, "unclear");

  assert.throws(
    () => evaluate(passing({ runs: {} }), thresholds),
    /^Error: NO_AUTHOR_RUN/,
  );
});

test("a check without results or with incomplete metrics is not run", () => {
  const r = passing();
  delete r.checks.C6;
  r.checks.C5 = { metrics: { plWithoutBest5: 10 } };
  r.checks.C2 = { notRun: "get_statistics failed" };
  const report = evaluate(r, thresholds);
  assert.equal(report.checks.C6.reason, "no result supplied");
  assert.equal(
    report.checks.C5.reason,
    "metrics missing: best10Share, positiveYearShare",
  );
  assert.equal(report.checks.C2.reason, "get_statistics failed");
  assert.equal(report.verdict, "unclear");
});

test("a null metric is a part not run: capped, the other rules still apply", () => {
  // C3 without a naive run on a filtered author: missing rule days cannot be read.
  const r = passing({ runs: { author: "a", cost_2x: "c" } });
  r.checks.C3 = {
    metrics: { maxYearDteMismatchShare: 0, missingRuleDayShare: null },
    notRunReason:
      "missing rule days need the naive run (author uses entry filters)",
  };
  let report = evaluate(r, thresholds);
  assert.equal(report.checks.C3.status, "partial");
  assert.equal(report.checks.C3.outcome, "cap");
  assert.match(report.checks.C3.reason, /need the naive run/);
  assert.ok(
    report.notTested.some((n) => n.id === "C3" && n.status === "partial"),
  );
  assert.match(summary(report, thresholds), /missingRuleDayShare not run/);
  // A part that could not run yet does not stop the triage at step 2.
  assert.equal(report.stoppedAt, null);

  r.checks.C3.metrics.maxYearDteMismatchShare = 0.4;
  report = evaluate(r, thresholds);
  assert.equal(report.checks.C3.outcome, "cap");
  assert.ok(
    report.checks.C3.triggered.some(
      (t) => t.metric === "maxYearDteMismatchShare",
    ),
  );

  r.checks.C3.metrics.maxYearDteMismatchShare = "high";
  assert.throws(() => evaluate(r, thresholds), /^Error: BAD_RESULTS/);
});

test("C8 runs with a minute_stop run and can reject", () => {
  const r = passing({
    authorUsesIntraMinuteStops: true,
    runs: { author: "a", naive: "n", cost_2x: "c", minute_stop: "m" },
    runSizes: { a: 1, n: 1, c: 1, m: 1 },
  });
  r.checks.C8 = { metrics: { minuteStopPl: -10, minuteStopDropShare: 1.2 } };
  assert.equal(evaluate(r, thresholds).verdict, "reject");
  r.checks.C8 = { metrics: { minuteStopPl: 100, minuteStopDropShare: 0.6 } };
  assert.equal(evaluate(r, thresholds).verdict, "unclear");
});

test("R9 guard: an interval excluding its point estimate is flagged and capped", () => {
  const report = evaluate(
    withCheck("C4", { point: 30, ciLow: 1, ciHigh: 20 }),
    thresholds,
  );
  assert.equal(report.checks.C4.outcome, "cap");
  assert.match(report.checks.C4.unreliable, /excludes its own point estimate/);
  assert.equal(report.verdict, "unclear");
});

test("C1 score: weighted share of stated fields; assumed core field caps", () => {
  const weights = thresholds.checks.C1.weights;
  const all = translationConfidence(fullSheet, weights);
  assert.equal(all.confidence, 1);
  assert.equal(all.assumedCoreFields, 0);

  const sheet = {
    ...fullSheet,
    stop: { value: "200 %", status: "assumed" },
    sizing: { value: "1", status: "n/a" },
  };
  const c = translationConfidence(sheet, weights);
  // core 7 x 2 = 14 (stop assumed), secondary 2 x 1 = 2 -> 14 applicable + 2 = 16; stated 12 + 2 = 14
  assert.equal(c.confidence, 14 / 16);
  assert.deepEqual(c.assumedCore, ["stop"]);

  const report = evaluate(
    passing({ source: { ref: "x", description: DESC }, ruleSheet: sheet }),
    thresholds,
  );
  assert.equal(report.checks.C1.outcome, "cap");
  assert.equal(report.verdict, "unclear");

  const low = {
    ...fullSheet,
    entry_filters: { value: "?", status: "assumed" },
    days_traded: { value: "?", status: "assumed" },
  };
  const lowC = translationConfidence(
    {
      underlying: fullSheet.underlying,
      entry_filters: low.entry_filters,
      days_traded: low.days_traded,
    },
    weights,
  );
  // underlying stated (2); two secondary fields assumed (1 + 1); the six missing core
  // fields count as assumed (6 x 2): 2 / 16.
  assert.equal(lowC.confidence, 2 / 16);

  assert.throws(
    () =>
      translationConfidence({ dte: { value: 7, status: "guess" } }, weights),
    /^Error: BAD_RULE_SHEET/,
  );
  assert.deepEqual(
    translationConfidence({ colour: stated("red") }, weights).unknownFields,
    ["colour"],
  );
});

test("summary: source first, light, one line per check, rule sheet, not tested", () => {
  const sheet = { ...fullSheet, stop: { value: "200 %", status: "assumed" } };
  const report = evaluate(
    passing({
      source: { ref: "Channel · Title · 2026-01-01", description: DESC },
      ruleSheet: sheet,
    }),
    thresholds,
  );
  const text = summary(report, thresholds);
  const lines = text.split("\n");
  assert.equal(lines[0], "Source: Channel · Title · 2026-01-01");
  assert.equal(lines[1], "🟡 Verdict: UNCLEAR");
  for (const id of ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"]) {
    assert.ok(
      lines.some((l) => l.startsWith(`${id} `)),
      id,
    );
  }
  assert.match(text, /\* stop: 200 %/);
  assert.match(
    text,
    /Not tested: C8 \(author run uses no intra-minute stops\)/,
  );
  assert.doesNotMatch(text, /robust/i);
});

test("log line carries inputs, checks, versions and the thresholds hash", () => {
  const report = evaluate(passing(), thresholds, { thresholdsSha256: "abc" });
  const line = JSON.parse(logLine(report));
  assert.equal(line.verdict, "continue");
  assert.equal(line.runAt, "2026-01-01T00:00:00Z");
  assert.equal(line.thresholdsSha256, "abc");
  assert.equal(line.thresholdsVersion, thresholds.version);
  assert.equal(line.versions.skill, "0.1.0");
  assert.deepEqual(Object.keys(line.checks), [
    "C1",
    "C2",
    "C3",
    "C4",
    "C5",
    "C6",
    "C7",
    "C8",
  ]);
  assert.ok(!logLine(report).includes("\n"));
});

test("log line carries the inputs; rule sheet is shown without a source too", () => {
  const sheet = { ...naSheet(), underlying: { value: "SPX", status: "n/a" } };
  const r = passing({
    blockId: "b1",
    costs: { slippage_per_side: 0.05 },
    ruleSheet: sheet,
  });
  const report = evaluate(r, thresholds);
  const line = JSON.parse(logLine(report));
  assert.deepEqual(line.inputs, {
    blockId: "b1",
    runs: r.runs,
    costs: { slippage_per_side: 0.05 },
    costsSha256: null,
  });
  const text = summary(report, thresholds);
  assert.match(
    text,
    /Rule sheet \(from the author run's settings; no source to compare\):/,
  );
  assert.match(text, /underlying: SPX/);
  assert.equal(report.checks.C1.status, "skipped");
});

test("CLI appends one log line per run and writes the summary", () => {
  const dir = mkdtempSync(join(tmpdir(), "triage-"));
  const results = join(dir, "results.json");
  writeFileSync(results, JSON.stringify(passing()));
  const log = join(dir, "verdicts.jsonl");
  const out = spawnSync(
    process.execPath,
    [
      script,
      "--results",
      results,
      "--log",
      log,
      "--summary",
      join(dir, "s.md"),
    ],
    {
      encoding: "utf8",
    },
  );
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).verdict, "continue");
  spawnSync(process.execPath, [script, "--results", results, "--log", log], {
    encoding: "utf8",
  });
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2);
  assert.ok(existsSync(join(dir, "s.md")));

  const bad = spawnSync(process.execPath, [script, "--results"], {
    encoding: "utf8",
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^USAGE:/);
});

// ---------------------------------------------------------------------------
// Calibration cases A1-A5 (frozen check results from TradeBlocks) and A7
// ---------------------------------------------------------------------------

const cases = existsSync(fixtures)
  ? readdirSync(fixtures).filter((d) =>
      existsSync(join(fixtures, d, "check-results.json")),
    )
  : [];

test("frozen calibration cases A1-A5 give their expected verdict", () => {
  assert.deepEqual(cases.sort(), ["A1", "A2", "A3", "A4", "A5"]);
  for (const id of cases) {
    const manifest = JSON.parse(
      readFileSync(join(fixtures, id, "triage.json"), "utf8"),
    );
    const { report } = run([
      "--results",
      join(fixtures, id, "check-results.json"),
      "--thresholds",
      thresholdsPath,
    ]);
    assert.ok(
      manifest.expected_verdict.includes(report.verdict),
      `${id}: ${report.verdict}`,
    );
    assert.notEqual(report.verdict, id === "A1" ? "continue" : "never");
  }
});

test("A7: rerun of A1-A5 with unchanged inputs is byte-identical", () => {
  for (const id of cases) {
    const args = [
      "--results",
      join(fixtures, id, "check-results.json"),
      "--thresholds",
      thresholdsPath,
    ];
    const first = run(args);
    const second = run(args);
    assert.equal(logLine(first.report), logLine(second.report), id);
    assert.equal(first.summary, second.summary, id);
  }
});

test("fixture generator is deterministic", async () => {
  const { generate } = await import("../scripts/triage-fixtures.mjs");
  const a = mkdtempSync(join(tmpdir(), "fx-a-"));
  const b = mkdtempSync(join(tmpdir(), "fx-b-"));
  generate(a);
  generate(b);
  for (const id of ["A1", "A2", "A3", "A4", "A5"]) {
    for (const f of ["tradelog.csv", "triage.json"]) {
      assert.equal(
        readFileSync(join(a, id, f), "utf8"),
        readFileSync(join(b, id, f), "utf8"),
        `${id}/${f}`,
      );
      assert.equal(
        readFileSync(join(a, id, f), "utf8"),
        readFileSync(join(fixtures, id, f), "utf8"),
        `${id}/${f} committed`,
      );
    }
  }
});
