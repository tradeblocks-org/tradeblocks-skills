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

import { readFileSync, appendFileSync, writeFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_VERSION = "0.1.0";
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
      fail("BAD_RULE_SHEET", `field ${field} has status ${JSON.stringify(status)}`);
    }
    const weight = core.has(field) ? weights.core : secondary.has(field) ? weights.secondary : null;
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

function applyRules(rules, metrics) {
  const missing = rules.map((r) => r.metric).filter((m) => typeof metrics?.[m] !== "number");
  if (missing.length > 0) return { outcome: null, missing, triggered: [] };
  const triggered = rules.filter((r) => OPS[r.op](metrics[r.metric], r.value));
  const outcome = triggered.reduce(
    (worst, r) => (SEVERITY[r.outcome] > SEVERITY[worst] ? r.outcome : worst),
    "pass",
  );
  return { outcome, missing: [], triggered };
}

function notRun(reason) {
  return { status: "not_run", outcome: "cap", reason };
}

/**
 * Evaluate one check-results object against the thresholds.
 * Returns the full report (verdict, per-check rows, not-tested list).
 */
export function evaluate(results, thresholds, { thresholdsSha256 = null } = {}) {
  if (!results || typeof results !== "object") fail("BAD_RESULTS", "not an object");
  const runs = results.runs ?? {};
  if (!runs.author) fail("NO_AUTHOR_RUN", "the author run is required for any triage");
  for (const id of ORDER) {
    if (!thresholds.checks?.[id]) fail("BAD_THRESHOLDS", `check ${id} missing`);
  }

  const rows = {};
  for (const id of ORDER) {
    const def = thresholds.checks[id];
    const supplied = results.checks?.[id];
    let row;
    if (id === "C1") {
      if (!results.source) {
        row = { status: "skipped", outcome: "pass", reason: "no source description supplied" };
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
      row = { status: "not_applicable", outcome: "pass", reason: "author run uses no intra-minute stops" };
    } else if (id === "C8" && !runs.minute_stop) {
      row = notRun("minute_stop run missing");
    } else if (!supplied || supplied.notRun) {
      row = notRun(supplied?.notRun ?? "no result supplied");
    } else {
      const { outcome, missing, triggered } = applyRules(def.rules, supplied.metrics);
      row =
        outcome === null
          ? notRun(`metrics missing: ${missing.join(", ")}`)
          : { status: "run", outcome, metrics: supplied.metrics, triggered };
    }

    // R9 guard: an interval that excludes its own point estimate is unreliable.
    if (id === "C4" && row.status === "run") {
      const { point, ciLow, ciHigh } = row.metrics;
      if (typeof ciHigh === "number" && (point < ciLow || point > ciHigh)) {
        row.unreliable = "bootstrap interval excludes its own point estimate";
        if (SEVERITY[row.outcome] < SEVERITY.cap) row.outcome = "cap";
      }
    }
    row.name = def.name;
    rows[id] = row;
  }

  // Gate: a C4 reject stops the triage; later checks are logged, not counted.
  const gateIndex = ORDER.indexOf("C4");
  const gateFailed = rows.C4.outcome === "reject";
  if (gateFailed) {
    for (const id of ORDER.slice(gateIndex + 1)) rows[id].afterGate = true;
  }
  const counted = ORDER.filter((id) => !rows[id].afterGate).map((id) => rows[id]);
  const verdict = counted.some((r) => r.outcome === "reject")
    ? "reject"
    : counted.some((r) => r.outcome === "cap")
      ? "unclear"
      : "continue";

  const notTested = ORDER.filter((id) =>
    ["not_run", "skipped", "not_applicable"].includes(rows[id].status),
  ).map((id) => ({ id, name: rows[id].name, status: rows[id].status, reason: rows[id].reason }));

  return {
    case: results.case ?? null,
    runAt: results.runAt ?? null,
    source: results.source ?? null,
    runs,
    ruleSheet: results.ruleSheet ?? null,
    variantsTried: results.variantsTried ?? null,
    verdict,
    light: { continue: "green", unclear: "yellow", reject: "red" }[verdict],
    gateFailed,
    checks: rows,
    notTested,
    thresholdsVersion: thresholds.version,
    thresholdsSha256,
    versions: { ...(results.versions ?? {}), skill: SKILL_VERSION },
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
    };
  }
  return JSON.stringify({
    runAt: report.runAt,
    case: report.case,
    source: report.source,
    ruleSheet: report.ruleSheet,
    confidence: report.checks.C1.metrics?.confidence ?? null,
    checks,
    verdict: report.verdict,
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
  if (unit === "USD" || unit === "USD/day") return `${value.toFixed(2)} ${unit}`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Phone-readable summary (R11). */
export function summary(report, thresholds) {
  const lines = [];
  const src = report.source;
  lines.push(src?.ref ? `Source: ${src.ref}` : `Source: not given (fidelity to a source not checked)`);
  const icon = { green: "🟢", yellow: "🟡", red: "🔴" }[report.light];
  lines.push(`${icon} Verdict: ${report.verdict.toUpperCase()}`);
  lines.push("");
  for (const id of ORDER) {
    const r = report.checks[id];
    const def = thresholds.checks[id];
    let detail;
    if (r.status === "run") {
      detail = def.rules
        .map((rule) => `${rule.metric} ${fmt(r.metrics[rule.metric], rule.unit)} (${rule.outcome} if ${rule.op} ${fmt(rule.value, rule.unit)})`)
        .join("; ");
    } else {
      detail = `${r.status.replace("_", " ")}: ${r.reason}`;
    }
    const tag = r.afterGate ? " [after failed gate, not counted]" : "";
    const flag = r.unreliable ? ` ⚠ ${r.unreliable}` : "";
    lines.push(`${id} ${r.name}: ${r.outcome.toUpperCase()}${tag} — ${detail}${flag}`);
  }
  if (report.ruleSheet) {
    lines.push("");
    lines.push("Rule sheet (assumed fields marked *):");
    for (const [field, entry] of Object.entries(report.ruleSheet)) {
      lines.push(`  ${entry.status === "assumed" ? "*" : " "} ${field}: ${entry.value}`);
    }
  }
  lines.push("");
  lines.push(
    report.notTested.length === 0
      ? "Not tested: nothing in the V1 catalogue was skipped."
      : "Not tested: " + report.notTested.map((n) => `${n.id} (${n.reason})`).join("; "),
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
    return { text: readFileSync(path, "utf8"), json: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    fail(reason, `${path}: ${error.message}`);
  }
}

export function run(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!["--results", "--thresholds", "--log", "--summary"].includes(key) || argv[i + 1] === undefined) {
      fail("USAGE", "triage-verdict.mjs --results <file> [--thresholds <file>] [--log <jsonl>] [--summary <file>]");
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

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { report } = run(process.argv.slice(2));
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
