#!/usr/bin/env node
// Triage verdict for is-this-backtest-lambo-or-lada.
//
// Reads one check-results file (metrics the skill collected from TradeBlocks),
// applies the thresholds file, computes the translation-confidence score C1
// from the rule sheet, caps for missing runs, and returns the verdict, one
// append-only JSONL log line and the phone-readable summary. The verdict is a
// pure function of its inputs: no clock, no randomness, no network.
//
//   node triage-verdict.mjs --results <file> [--thresholds <file>]
//                           [--log <jsonl>] [--summary <file>]
//
// Exit 0 with the report as JSON on stdout; on bad input exit 1 with
// "REASON: detail" on stderr.

import {
  readFileSync,
  appendFileSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_VERSION = "0.1.0";
// Content hash of this script: identifies the exact verdict logic in the log (R8).
const SCRIPT_SHA256 = createHash("sha256")
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex");
const DEFAULT_THRESHOLDS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "is-this-backtest-lambo-or-lada",
  "thresholds.json",
);

const ORDER = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"];
const SEVERITY = { pass: 0, cap: 1, reject: 2 };
const OPS = {
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
};

function fail(reason, detail) {
  throw new Error(`${reason}: ${detail}`);
}

const OUTCOMES = new Set(["cap", "reject"]);

/** Refuse a thresholds file the verdict cannot apply exactly (user copies included). */
export function validateThresholds(thresholds) {
  if (!thresholds || typeof thresholds !== "object")
    fail("BAD_THRESHOLDS", "not an object");
  for (const id of ORDER) {
    const def = thresholds.checks?.[id];
    if (!def) fail("BAD_THRESHOLDS", `check ${id} missing`);
    if (!Array.isArray(def.rules) || def.rules.length === 0)
      fail("BAD_THRESHOLDS", `${id} has no rules`);
    def.rules.forEach((r, i) => {
      if (typeof r.metric !== "string" || r.metric === "")
        fail("BAD_THRESHOLDS", `${id} rule ${i} metric`);
      if (!(r.op in OPS))
        fail("BAD_THRESHOLDS", `${id} rule ${i} op ${JSON.stringify(r.op)}`);
      if (!OUTCOMES.has(r.outcome))
        fail(
          "BAD_THRESHOLDS",
          `${id} rule ${i} outcome ${JSON.stringify(r.outcome)}`,
        );
      if (typeof r.value !== "number" || !Number.isFinite(r.value)) {
        fail(
          "BAD_THRESHOLDS",
          `${id} rule ${i} value ${JSON.stringify(r.value)}`,
        );
      }
    });
  }
  const w = thresholds.checks.C1.weights;
  if (!w || !Array.isArray(w.coreFields) || !Array.isArray(w.secondaryFields)) {
    fail("BAD_THRESHOLDS", "C1 weights need coreFields and secondaryFields");
  }
}

/** Every rule field present (n/a allowed), no unknown names, a known status each (R1). */
export function validateRuleSheet(ruleSheet, weights) {
  if (!ruleSheet || typeof ruleSheet !== "object")
    fail("BAD_RULE_SHEET", "rule sheet missing");
  const known = [...weights.coreFields, ...weights.secondaryFields];
  // Unknown names first: a misspelt field is reported as such, not as missing.
  const unknown = Object.keys(ruleSheet).filter((f) => !known.includes(f));
  if (unknown.length > 0)
    fail("BAD_RULE_SHEET", `unknown fields: ${unknown.join(", ")}`);
  const missing = known.filter((f) => !(f in ruleSheet));
  if (missing.length > 0)
    fail("BAD_RULE_SHEET", `missing fields: ${missing.join(", ")}`);
  for (const [field, entry] of Object.entries(ruleSheet)) {
    if (!["stated", "assumed", "n/a"].includes(entry?.status)) {
      fail(
        "BAD_RULE_SHEET",
        `field ${field} has status ${JSON.stringify(entry?.status)}`,
      );
    }
  }
}

const hasDescription = (source) =>
  !!source &&
  ((typeof source.description === "string" &&
    source.description.trim() !== "") ||
    (typeof source.descriptionSha256 === "string" &&
      /^[0-9a-f]{64}$/.test(source.descriptionSha256)));

// ---------------------------------------------------------------------------
// C1 translation confidence
// ---------------------------------------------------------------------------

/** Weighted share of stated rule fields; assumed core fields counted separately. */
export function translationConfidence(ruleSheet, weights) {
  const core = new Set(weights.coreFields);
  const secondary = new Set(weights.secondaryFields);
  let stated = 0;
  let applicable = 0;
  const assumedCore = [];
  const assumed = [];
  const unknown = [];
  for (const [field, entry] of Object.entries(ruleSheet ?? {})) {
    const status = entry?.status;
    if (!["stated", "assumed", "n/a"].includes(status)) {
      fail(
        "BAD_RULE_SHEET",
        `field ${field} has status ${JSON.stringify(status)}`,
      );
    }
    const weight = core.has(field)
      ? weights.core
      : secondary.has(field)
        ? weights.secondary
        : null;
    if (weight === null) {
      unknown.push(field);
      continue;
    }
    if (status === "n/a") continue;
    applicable += weight;
    if (status === "stated") stated += weight;
    else {
      assumed.push(field);
      if (core.has(field)) assumedCore.push(field);
    }
  }
  return {
    confidence: applicable === 0 ? 0 : stated / applicable,
    assumedCoreFields: assumedCore.length,
    assumedCore,
    assumed,
    unknownFields: unknown,
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Apply a check's rules. A metric that is absent makes the whole check not
 * run; a metric that is explicitly null means only that part could not run:
 * its rule is skipped, the check is capped, the other rules still apply.
 */
function applyRules(rules, metrics) {
  const missing = rules
    .map((r) => r.metric)
    .filter((m) => metrics?.[m] === undefined);
  if (missing.length > 0)
    return { outcome: null, missing, notRunParts: [], triggered: [] };
  const notRunParts = rules
    .map((r) => r.metric)
    .filter((m) => metrics[m] === null);
  const bad = rules
    .map((r) => r.metric)
    .filter((m) => metrics[m] !== null && typeof metrics[m] !== "number");
  if (bad.length > 0)
    fail("BAD_RESULTS", `metrics must be numbers or null: ${bad.join(", ")}`);
  const triggered = rules.filter(
    (r) => metrics[r.metric] !== null && OPS[r.op](metrics[r.metric], r.value),
  );
  let outcome = triggered.reduce(
    (worst, r) => (SEVERITY[r.outcome] > SEVERITY[worst] ? r.outcome : worst),
    "pass",
  );
  if (notRunParts.length > 0 && SEVERITY[outcome] < SEVERITY.cap)
    outcome = "cap";
  return { outcome, missing: [], notRunParts, triggered };
}

function notRun(reason) {
  return { status: "not_run", outcome: "cap", reason };
}

/**
 * Evaluate one check-results object against the thresholds.
 * Returns the full report (verdict, per-check rows, not-tested list).
 */
export function evaluate(
  results,
  thresholds,
  { thresholdsSha256 = null } = {},
) {
  if (!results || typeof results !== "object")
    fail("BAD_RESULTS", "not an object");
  validateThresholds(thresholds);
  const runs = results.runs ?? {};
  if (!runs.author)
    fail("NO_AUTHOR_RUN", "the author run is required for any triage");
  for (const flag of ["authorUsesIntraMinuteStops", "authorCostsMatchBase"]) {
    if (typeof results[flag] !== "boolean") {
      fail(
        "BAD_RESULTS",
        `${flag} must be true or false (read it from the author run's settings)`,
      );
    }
  }
  validateRuleSheet(results.ruleSheet, thresholds.checks.C1.weights);

  // R6: every check reads the run on the user's base costs. author_base replaces
  // the author run when the author's own costs differ from the base scenario.
  const costBasis = results.authorCostsMatchBase
    ? { status: "base", checkedRun: runs.author }
    : runs.author_base
      ? { status: "base", checkedRun: runs.author_base, replaces: runs.author }
      : {
          status: "not_base",
          checkedRun: runs.author,
          reason:
            "author run is not on the base cost scenario and the author_base run is missing",
        };

  const rows = {};
  for (const id of ORDER) {
    const def = thresholds.checks[id];
    const supplied = results.checks?.[id];
    let row;
    if (id === "C1") {
      if (!hasDescription(results.source)) {
        row = {
          status: "skipped",
          outcome: "pass",
          reason: "no source description supplied",
        };
      } else {
        const c1 = translationConfidence(results.ruleSheet, def.weights);
        const { outcome, triggered } = applyRules(def.rules, c1);
        row = { status: "run", outcome, metrics: c1, triggered };
      }
    } else if (id === "C4" && !runs.naive) {
      row = notRun("naive run missing");
    } else if (id === "C7" && !runs.cost_2x) {
      row = notRun("cost_2x run missing");
    } else if (id === "C8" && results.authorUsesIntraMinuteStops !== true) {
      row = {
        status: "not_applicable",
        outcome: "pass",
        reason: "author run uses no intra-minute stops",
      };
    } else if (id === "C8" && !runs.minute_stop) {
      row = notRun("minute_stop run missing");
    } else if (!supplied || supplied.notRun) {
      row = notRun(supplied?.notRun ?? "no result supplied");
    } else {
      const { outcome, missing, notRunParts, triggered } = applyRules(
        def.rules,
        supplied.metrics,
      );
      row =
        outcome === null
          ? notRun(`metrics missing: ${missing.join(", ")}`)
          : {
              status: notRunParts.length > 0 ? "partial" : "run",
              outcome,
              metrics: supplied.metrics,
              triggered,
              ...(notRunParts.length > 0
                ? {
                    reason:
                      supplied.notRunReason ??
                      `not run: ${notRunParts.join(", ")}`,
                  }
                : {}),
            };
    }

    // R9 guard: an interval that excludes its own point estimate is unreliable.
    if (id === "C4" && (row.status === "run" || row.status === "partial")) {
      const { point, ciLow, ciHigh } = row.metrics;
      if (typeof ciHigh === "number" && (point < ciLow || point > ciHigh)) {
        row.unreliable = "bootstrap interval excludes its own point estimate";
        if (SEVERITY[row.outcome] < SEVERITY.cap) row.outcome = "cap";
      }
    }
    row.name = def.name;
    rows[id] = row;
  }

  // Step 2: a C3 cap means the backtest is not the strategy. The triage stops
  // with unclear; later checks are logged, not counted, and never reject (Q6).
  // Only a triggered rule stops; a part that could not run yet (no naive run)
  // caps the verdict but lets the triage go on to the run request.
  let stoppedAt = null;
  if ((rows.C3.triggered ?? []).length > 0) {
    stoppedAt = "C3";
    for (const id of ORDER.slice(ORDER.indexOf("C3") + 1))
      rows[id].afterStop = true;
  }
  // Gate: a C4 reject stops the triage; later checks are logged, not counted.
  const gateFailed = stoppedAt === null && rows.C4.outcome === "reject";
  if (gateFailed) {
    for (const id of ORDER.slice(ORDER.indexOf("C4") + 1))
      rows[id].afterGate = true;
  }
  const counted = ORDER.filter(
    (id) => !rows[id].afterGate && !rows[id].afterStop,
  ).map((id) => rows[id]);
  const capped =
    counted.some((r) => r.outcome === "cap") || costBasis.status !== "base";
  const verdict = counted.some((r) => r.outcome === "reject")
    ? "reject"
    : capped
      ? "unclear"
      : "continue";

  const notTested = ORDER.filter((id) =>
    ["not_run", "partial", "skipped", "not_applicable"].includes(
      rows[id].status,
    ),
  ).map((id) => ({
    id,
    name: rows[id].name,
    status: rows[id].status,
    reason: rows[id].reason,
  }));
  if (costBasis.status !== "base") {
    notTested.unshift({
      id: "costs",
      name: "Base cost scenario",
      status: "not_run",
      reason: costBasis.reason,
    });
  }

  return {
    case: results.case ?? null,
    runAt: results.runAt ?? null,
    source: results.source ?? null,
    runs,
    blockId: results.blockId ?? null,
    costs: results.costs ?? null,
    ruleSheet: results.ruleSheet ?? null,
    variantsTried: results.variantsTried ?? null,
    verdict,
    light: { continue: "green", unclear: "yellow", reject: "red" }[verdict],
    gateFailed,
    stoppedAt,
    costBasis,
    checks: rows,
    notTested,
    thresholdsVersion: thresholds.version,
    thresholdsSha256,
    versions: {
      ...(results.versions ?? {}),
      skill: SKILL_VERSION,
      verdictScriptSha256: SCRIPT_SHA256,
    },
    ooRunIds: results.ooRunIds ?? [],
    runFolder: results.runFolder ?? null,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** One JSONL log line (R8). Deterministic: no clock; the caller supplies runAt. */
export function logLine(report) {
  const checks = {};
  for (const id of ORDER) {
    const r = report.checks[id];
    checks[id] = {
      status: r.status,
      outcome: r.outcome,
      ...(r.metrics ? { metrics: r.metrics } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.unreliable ? { unreliable: r.unreliable } : {}),
      ...(r.afterGate ? { afterGate: true } : {}),
      ...(r.afterStop ? { afterStop: true } : {}),
    };
  }
  return JSON.stringify({
    runAt: report.runAt,
    case: report.case,
    source: report.source,
    inputs: { blockId: report.blockId, runs: report.runs, costs: report.costs },
    ruleSheet: report.ruleSheet,
    confidence: report.checks.C1.metrics?.confidence ?? null,
    checks,
    verdict: report.verdict,
    stoppedAt: report.stoppedAt,
    costBasis: report.costBasis,
    variantsTried: report.variantsTried,
    thresholdsVersion: report.thresholdsVersion,
    thresholdsSha256: report.thresholdsSha256,
    versions: report.versions,
    ooRunIds: report.ooRunIds,
    runFolder: report.runFolder,
  });
}

function fmt(value, unit) {
  if (typeof value !== "number") return String(value);
  if (unit === "share") return `${(value * 100).toFixed(1)} %`;
  if (unit === "USD" || unit === "USD/day")
    return `${value.toFixed(2)} ${unit}`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Phone-readable summary (R11). */
export function summary(report, thresholds) {
  const lines = [];
  const src = report.source;
  lines.push(
    src?.ref
      ? `Source: ${src.ref}`
      : `Source: not given (fidelity to a source not checked)`,
  );
  const icon = { green: "🟢", yellow: "🟡", red: "🔴" }[report.light];
  lines.push(`${icon} Verdict: ${report.verdict.toUpperCase()}`);
  if (report.stoppedAt === "C3") {
    lines.push(
      "Stopped at step 2: the backtest does not trade the stated rules (C3). Fix the rules and rerun; this is not a verdict on the strategy.",
    );
  }
  lines.push(
    report.costBasis.status === "base"
      ? `Costs: checks read ${report.costBasis.checkedRun} on the base cost scenario.`
      : `Costs: ${report.costBasis.reason}; verdict capped.`,
  );
  lines.push("");
  for (const id of ORDER) {
    const r = report.checks[id];
    const def = thresholds.checks[id];
    let detail;
    if (r.status === "run" || r.status === "partial") {
      detail = def.rules
        .map((rule) =>
          r.metrics[rule.metric] === null
            ? `${rule.metric} not run`
            : `${rule.metric} ${fmt(r.metrics[rule.metric], rule.unit)} (${rule.outcome} if ${rule.op} ${fmt(rule.value, rule.unit)})`,
        )
        .join("; ");
      if (r.status === "partial") detail += ` — ${r.reason}`;
    } else {
      detail = `${r.status.replace("_", " ")}: ${r.reason}`;
    }
    const tag = r.afterGate
      ? " [after failed gate, not counted]"
      : r.afterStop
        ? " [after step-2 stop, not counted]"
        : "";
    const flag = r.unreliable ? ` ⚠ ${r.unreliable}` : "";
    lines.push(
      `${id} ${r.name}: ${r.outcome.toUpperCase()}${tag} — ${detail}${flag}`,
    );
  }
  if (report.ruleSheet) {
    lines.push("");
    lines.push(
      report.source
        ? "Rule sheet (assumed fields marked *):"
        : "Rule sheet (from the author run's settings; no source to compare):",
    );
    for (const [field, entry] of Object.entries(report.ruleSheet)) {
      lines.push(
        `  ${entry.status === "assumed" ? "*" : " "} ${field}: ${entry.value}`,
      );
    }
  }
  lines.push("");
  lines.push(
    report.notTested.length === 0
      ? "Not tested: nothing in the V1 catalogue was skipped."
      : "Not tested: " +
          report.notTested.map((n) => `${n.id} (${n.reason})`).join("; "),
  );
  lines.push(
    "Limits: one in-sample record, checks not adjusted for selecting this strategy among " +
      `${report.variantsTried ?? "an unknown number of"} variants; triage is not due diligence.`,
  );
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readJson(path, reason) {
  try {
    return {
      text: readFileSync(path, "utf8"),
      json: JSON.parse(readFileSync(path, "utf8")),
    };
  } catch (error) {
    fail(reason, `${path}: ${error.message}`);
  }
}

export function run(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (
      !["--results", "--thresholds", "--log", "--summary"].includes(key) ||
      argv[i + 1] === undefined
    ) {
      fail(
        "USAGE",
        "triage-verdict.mjs --results <file> [--thresholds <file>] [--log <jsonl>] [--summary <file>]",
      );
    }
    args[key.slice(2)] = argv[i + 1];
  }
  if (!args.results) fail("USAGE", "--results is required");
  const thresholdsPath = args.thresholds ?? DEFAULT_THRESHOLDS;
  const { text, json: thresholds } = readJson(thresholdsPath, "BAD_THRESHOLDS");
  const { json: results } = readJson(args.results, "BAD_RESULTS");
  const sha = createHash("sha256").update(text).digest("hex");
  const report = evaluate(results, thresholds, { thresholdsSha256: sha });
  const text_ = summary(report, thresholds);
  if (args.log) appendFileSync(args.log, logLine(report) + "\n");
  if (args.summary) writeFileSync(args.summary, text_);
  return { report, summary: text_ };
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { report } = run(process.argv.slice(2));
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
