#!/usr/bin/env node
// Triage verdict for is-this-backtest-lambo-or-lada.
//
// Reads one check-results file (metrics the skill collected from TradeBlocks)
// and, next to it, run-request.json (flags, costs, date range: written by
// triage-run-request.mjs), plugin-result.json (block, run labels, capture ids)
// and rule-sheet.json; applies the shipped thresholds.json, computes the
// C1 (the core fields not stated) from the rule sheet, caps for missing runs,
// and returns the verdict, one append-only JSONL log line and the
// phone-readable summary. The verdict is a pure function of its inputs: no
// clock, no randomness, no network.
//
//   node triage-verdict.mjs --results <file> [--log <jsonl>] [--summary <file>]
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

export const SKILL_VERSION = "1.0.0";
// Content hash of this script: identifies the exact verdict logic in the log (R8).
const SCRIPT_SHA256 = createHash("sha256")
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex");
export const THRESHOLDS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "is-this-backtest-lambo-or-lada",
  "thresholds.json",
);

const COSTS_EXAMPLE = "costs: example (not your own)";
const ORDER = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9"];
// The runs besides the checked one that a check reads.
const OTHER_ROLES = { C4: ["naive"], C7: ["cost_2x"], C9: ["stop_tight", "stop_wide"] };
const months = (from, through) => (Date.parse(through) - Date.parse(from)) / 864e5 / 30.4375;

/**
 * V1.1 C8 metrics from the realistic run's net P&L in full (netPl) and from each
 * later start of the run request (trades opened on or after it); null = not run.
 */
function startDateMetrics(c8, rr, fullPl) {
  const starts = c8?.starts;
  if (!Array.isArray(starts)) return null;
  const dates = starts.map((x) => x?.startDate);
  if (JSON.stringify(dates) !== JSON.stringify(rr.c8Starts) || starts.some((x) => typeof x.netPl !== "number"))
    fail("BAD_RESULTS", `C8 starts are the c8Sql rows unchanged ({ "startDate", "netPl" }), one per later start of the run request: ${rr.c8Starts.join(", ")}`);
  // PRD C8 / R8: every start's net P&L and average month stay in the report and log.
  const perStart = starts.map((x) => ({ startDate: x.startDate, netPl: x.netPl, avgMonthPl: x.netPl / months(x.startDate, rr.range.through) }));
  const full = fullPl / months(rr.range.from, rr.range.through);
  return {
    laterStarts: starts.length,
    minLaterStartPl: Math.min(...starts.map((x) => x.netPl)),
    latestStartAvgMonthShare: full > 0 ? perStart.at(-1).avgMonthPl / full : 0,
    fullPl,
    avgMonthPl: full,
    starts: perStart,
  };
}
// C2, C5-C7, C9 from the raw TradeBlocks numbers (the formulas live only here).
const RAW = { C2: ["entries", "firstPeriod", "lastPeriod"], C5: ["plWithoutBest5", "best10ShareOfTotal", "positiveYearShare"], C6: ["windowNetPl"] };
const month = (p) => (/^\d{4}-\d{2}$/.test(p) ? Number(p.slice(0, 4)) * 12 + Number(p.slice(5)) : NaN);
function fromRaw(id, c, netPl, real, c2Months, range, realSize) {
  if (c?.notRun || !(id in RAW || id === "C7" || id === "C9")) return c;
  if (c?.metrics) fail("BAD_RESULTS", `${id} takes the raw TradeBlocks numbers, not metrics (templates/check-results.json)`);
  if (id === "C2" && c && "trades" in c) fail("BAD_RESULTS", "C2 counts entries, not trades: entries is the runSizes entries of the realistic run (step 4)");
  const missing = (RAW[id] ?? []).filter((k) => c?.[k] === undefined);
  if (missing.length) return c && { notRun: `numbers missing: ${missing.join(", ")}` };
  // A field the agent could not read is null plus notRunReason: a C2 period or the C6 windows leave nothing to compute.
  const why = c?.notRunReason;
  if (why && ((id === "C2" && (c.firstPeriod === null || c.lastPeriod === null)) || (id === "C6" && c.windowNetPl === null))) return { notRun: why };
  const unread = ({ C6: [real], C7: [real, "cost_2x"], C9: [real, "stop_tight", "stop_wide"] }[id] ?? []).find((role) => netPl[role] == null);
  if (unread) return { notRun: `net P&L of the ${unread === real ? "realistic" : unread} run not read (netPl.${unread})` };
  // A keep share is 0 when the realistic run did not make money.
  const keep = (role) => (netPl[real] > 0 ? netPl[role] / netPl[real] : 0);
  if (id === "C2") {
    const months = month(c.lastPeriod) - month(c.firstPeriod) + 1;
    if (!(months > 0)) fail("BAD_RESULTS", "C2 firstPeriod and lastPeriod are get_period_returns periods (YYYY-MM): the realistic run's first and last (one not read: null plus notRunReason)");
    // PRD C2: entries (distinct open date and time), so one exit group per side is not counted twice.
    if (typeof realSize?.entries === "number" && c.entries !== realSize.entries)
      fail("BAD_RESULTS", `C2 entries ${c.entries} is not the runSizes entries of the realistic run (${realSize.entries}): copy it from there`);
    return { metrics: { entries: c.entries, months }, notRunReason: why };
  }
  // TradeBlocks returns shareOfTotal null when the total is not positive: all of it rests on the best days; with a notRunReason it was not read.
  if (id === "C5") return { metrics: { plWithoutBest5: c.plWithoutBest5, best10Share: c.best10ShareOfTotal ?? (why ? null : 1), positiveYearShare: c.positiveYearShare }, notRunReason: why,
    ...(c.best10ShareOfTotal === null && !why ? { totalNotPositive: true } : {}) };
  if (id === "C7") return { metrics: { cost2xPl: netPl.cost_2x, cost2xKeepShare: keep("cost_2x") } };
  if (id === "C9")
    return { metrics: { stopTightPl: netPl.stop_tight, stopWidePl: netPl.stop_wide, stopTightKeepShare: keep("stop_tight"), stopWideKeepShare: keep("stop_wide") } };
  const all = c.windowNetPl;
  const day = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!Array.isArray(all) || all.some((x) => typeof x?.name !== "string" || !day(x.start) || !day(x.end) || typeof x.netPl !== "number"))
    fail("BAD_RESULTS", "C6 windowNetPl is one { name, start, end, netPl } per stress window with the realistic run's trades: name and dateRange from stress_test, netPl from get_statistics (leave out a window with no trades)");
  if (typeof c2Months !== "number") return { notRun: "C2 months not read (C6 counts the worst window in average months)" };
  // PRD C6: only windows fully inside the record's range are stress periods of the record.
  const inside = (x) => x.start >= range.from && x.end <= range.through;
  const w = all.filter(inside).map((x) => x.netPl);
  const outside = all.filter((x) => !inside(x));
  const [avgMonth, worst] = [netPl[real] / c2Months, Math.min(0, ...w)];
  // A losing strategy fails the stress test by definition: 99 (> 12, reject) before "no window lost".
  return { metrics: { stressPeriodsInRecord: w.length, worstStressLossInAvgMonths: avgMonth <= 0 ? 99 : worst >= 0 ? 0 : -worst / avgMonth },
    ...(outside.length ? { windowsOutside: outside } : {}) };
}
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

/**
 * R1: no unknown names, a known status each, every secondary field present
 * (n/a allowed). A core field missing from the sheet counts as assumed.
 */
export function validateRuleSheet(ruleSheet, c1) {
  if (!ruleSheet || typeof ruleSheet !== "object")
    fail("BAD_RULE_SHEET", "rule sheet missing");
  const known = [...c1.coreFields, ...c1.secondaryFields];
  // Unknown names first: a misspelt field is reported as such, not as missing.
  const unknown = Object.keys(ruleSheet).filter((f) => !known.includes(f));
  if (unknown.length > 0)
    fail("BAD_RULE_SHEET", `unknown fields: ${unknown.join(", ")}`);
  const missing = c1.secondaryFields.filter((f) => !(f in ruleSheet));
  if (missing.length > 0)
    fail("BAD_RULE_SHEET", `missing secondary fields: ${missing.join(", ")}`);
  for (const [field, entry] of Object.entries(ruleSheet)) {
    if (!["stated", "assumed", "n/a"].includes(entry?.status)) {
      fail(
        "BAD_RULE_SHEET",
        `field ${field} has status ${JSON.stringify(entry?.status)}`,
      );
    }
  }
}

export const hasDescription = (source) =>
  !!source &&
  ((typeof source.description === "string" &&
    source.description.trim() !== "") ||
    (typeof source.descriptionSha256 === "string" &&
      /^[0-9a-f]{64}$/.test(source.descriptionSha256)));

// ---------------------------------------------------------------------------
// C1: core fields not stated
// ---------------------------------------------------------------------------

/** every core field not stated (assumed, n/a or missing from the sheet) counts as assumed; no score. */
export function coreNotStated(ruleSheet, c1) {
  // validateRuleSheet has refused unknown fields and statuses.
  const assumedCore = c1.coreFields.filter((f) => ruleSheet?.[f]?.status !== "stated");
  return { assumedCoreFields: assumedCore.length, assumedCore };
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

const EXIT_CLASSES = [
  ["profit_target", /profit/i],
  ["stop", /stop/i],
  ["expiry", /expir/i],
  // Word-anchored: "Conditional" and "Submitted" contain "dit"/"mit" but are no time exits.
  ["time", /\btime\b|\bdte\b|\bdit\b|\bmit\b/i],
];
// Option Omega closes a position still open at the end of the range as
// "Backtest Completed" (closeOpenTradesAtTestCompletion). One such exit per
// run is the end of the test, not a trading decision: it is left out of the
// mix. Any further one counts as "other".
const END_OF_TEST = /backtest completed/i;

/** Exit-reason counts by class (profit target, stop, expiry, time, other). */
function exitClasses(counts) {
  const out = { profit_target: 0, stop: 0, expiry: 0, time: 0, other: 0 };
  let endOfTestLeft = 1;
  for (const [reason, n] of Object.entries(counts)) {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      fail(
        "BAD_RESULTS",
        `exit-reason count for ${JSON.stringify(reason)} must be a number`,
      );
    }
    let count = n;
    if (END_OF_TEST.test(reason)) {
      const neutral = Math.min(count, endOfTestLeft);
      endOfTestLeft -= neutral;
      count -= neutral;
    }
    const cls = EXIT_CLASSES.find(([, re]) => re.test(reason))?.[0] ?? "other";
    out[cls] += count;
  }
  return out;
}

/**
 * Largest difference in exit-reason share between author and author_base,
 * over the exit classes `compared` (all by default).
 */
export function compareExitMix(author, authorBase, rule, compared = null) {
  const a = exitClasses(author);
  const b = exitClasses(authorBase);
  const ta = Object.values(a).reduce((x, y) => x + y, 0);
  const tb = Object.values(b).reduce((x, y) => x + y, 0);
  if (ta === 0 || tb === 0) {
    return {
      status: "not_run",
      reason: "no exit reasons counted for the author run or the realistic run (author_base)",
    };
  }
  // PRD exit mix: nothing to compare when every compared class is 0 on both runs (no cap).
  if (compared && compared.every((k) => a[k] === 0 && b[k] === 0))
    return { status: "not_compared", reason: "no profit-target or time exits to compare", compared, author: a, authorBase: b };
  const diffs = Object.fromEntries(
    (compared ?? Object.keys(a)).map((k) => [k, Math.abs(a[k] / ta - b[k] / tb)]),
  );
  const maxShareDiff = Math.max(...Object.values(diffs));
  const changed = OPS[rule.op](maxShareDiff, rule.value);
  return {
    status: changed ? "changed" : "same",
    maxShareDiff,
    ...(compared ? { compared } : {}),
    author: a,
    authorBase: b,
    ...(changed
      ? {
          reason:
            "re-costing changed the exit-reason mix (the realistic run, author_base, does not trade like the author run)",
        }
      : {}),
  };
}

/**
 * Evaluate one check-results object against the run folder's run request,
 * plugin result and rule sheet, and the thresholds.
 * Returns the full report (verdict, per-check rows, not-tested list).
 */
export function evaluate(checkResults, { runRequest: rr, pluginResult: pr, ruleSheet: rs }, thresholds, { thresholdsSha256 = null } = {}) {
  if (!checkResults || typeof checkResults !== "object")
    fail("BAD_RESULTS", "not an object");
  if (
    typeof rr?.flags?.author_costs_match_base !== "boolean" ||
    typeof rr.flags.author_without_intra_minute !== "boolean" ||
    typeof rr.flags.author_has_stop !== "boolean" ||
    !Array.isArray(rr.c8Starts) ||
    typeof rr.costsExample !== "boolean" ||
    typeof rr.range?.from !== "string" ||
    typeof rr.range?.through !== "string" ||
    !Array.isArray(rr.zeroCostFields) ||
    !Array.isArray(rr.runs)
  ) {
    fail("BAD_RUN_REQUEST", "run-request.json is not the output of triage-run-request.mjs: rerun it with --run-folder");
  }
  // One block; each run with the label the run request gave it and its capture id.
  const bad = (d) => fail("BAD_PLUGIN_RESULT", d);
  if (typeof pr?.block_id !== "string" || pr.block_id === "") bad("block_id is required");
  const asked = Object.fromEntries(rr.runs.map((r) => [r.role, r.label]));
  for (const [role, v] of Object.entries(pr.runs ?? {})) {
    if (!(role in asked)) bad(`${role}: the run request did not ask for this run`);
    if (v?.label !== asked[role]) bad(`${role}: label ${JSON.stringify(v?.label)} is not the run request's ${JSON.stringify(asked[role])}`);
    if (typeof v.capture_id !== "string" || v.capture_id === "") bad(`${role}: capture_id (the run's oo-capture id) is required`);
  }
  const pick = (k) => Object.fromEntries(Object.entries(pr.runs ?? {}).map(([role, v]) => [role, v[k]]));
  // What identifies the runs comes from the run folder's files: a copy in the check results is overwritten.
  const results = {
    ...checkResults,
    runs: pick("label"),
    blockId: pr.block_id,
    captureIds: pick("capture_id"),
    source: rs?.source ?? null,
    ruleSheet: rs?.rule_sheet,
    variantsTried: rs?.variants_tried ?? null,
  };
  const authorCostsMatchBase = rr.flags.author_costs_match_base;
  // The author run without intra-minute stops, every check run with them.
  const authorWithoutIntraMinute = rr.flags.author_without_intra_minute;
  const runs = results.runs;
  if (!runs.author)
    fail("NO_AUTHOR_RUN", "the author run is required for any triage");
  validateRuleSheet(results.ruleSheet, thresholds.checks.C1);
  // C3: missing rule days come from the run the run request names (naive when the author skips rule days on purpose).
  const c3 = results.checks?.C3;
  if (typeof rr.c3MissingDaysRun === "string" && typeof c3?.metrics?.missingRuleDayShare === "number" && c3.missingRuleDaysRun !== rr.c3MissingDaysRun)
    fail("BAD_RESULTS", `C3 missingRuleDayShare must be read from the ${rr.c3MissingDaysRun} run (run-request.json c3MissingDaysRun); got ${JSON.stringify(c3.missingRuleDaysRun ?? null)} as missingRuleDaysRun: call get_rule_calendar on that run and name it, or set missingRuleDayShare null with a notRunReason if that run does not exist`);
  if (!results.runSizes || typeof results.runSizes !== "object") {
    fail(
      "BAD_RESULTS",
      "runSizes (distinct contract counts per run label) is required",
    );
  }
  for (const [label, size] of Object.entries(results.runSizes)) {
    if (!Number.isInteger(size?.n) || !(size.contracts === null || typeof size.contracts === "number") || !(size.entries === undefined || Number.isInteger(size.entries)))
      fail("BAD_RESULTS", `runSizes: ${label} needs { n, contracts, entries } (the run_sql in step 4)`);
  }

  // R6: every check but C3 reads the realistic run, on the user's base costs: author_base
  // replaces the author run when the author's own costs differ from the base scenario.
  // Also when the author run is without intra-minute stops on the base costs.
  const realisticBase = !authorCostsMatchBase || authorWithoutIntraMinute;
  const costBasis = !realisticBase
    ? { status: "base", checkedRun: runs.author }
    : runs.author_base
      ? { status: "base", checkedRun: runs.author_base, replaces: runs.author }
      : {
          status: "not_base",
          checkedRun: runs.author,
          reason: `author run is ${authorCostsMatchBase ? "without intra-minute stops" : "not on the base cost scenario"} and the realistic run (author_base) is missing`,
        };

  // author_base must trade like the author run: re-costing must not change the
  // exit-reason mix (e.g. a closing-order target that fills only at 0 slippage).
  const exitMix = !runs.author_base
    ? { status: "n/a" }
    : results.exitMix?.author && results.exitMix?.authorBase
      ? compareExitMix(
          results.exitMix.author,
          results.exitMix.authorBase,
          thresholds.exitMix,
          // Intra-minute stops alone move exits between stop and expiry.
          authorWithoutIntraMinute ? ["profit_target", "time"] : null,
        )
      : {
          status: "not_run",
          reason: "exit-reason counts of the author run and the realistic run (author_base) not read",
        };

  const netPl = results.netPl ?? {};
  for (const [role, v] of Object.entries(netPl))
    if (v !== null && typeof v !== "number") fail("BAD_RESULTS", `netPl.${role} must be get_statistics netPl (a number) of that run, or null`);
  const realRole = realisticBase ? "author_base" : "author";
  const c2 = fromRaw("C2", results.checks?.C2, netPl, realRole, undefined, rr.range, results.runSizes[costBasis.checkedRun]);
  const rows = {};
  for (const id of ORDER) {
    const def = thresholds.checks[id];
    let supplied = id === "C2" ? c2 : fromRaw(id, results.checks?.[id], netPl, realRole, c2?.metrics?.months, rr.range);
    // C2 fixed size: the realistic run's distinct contract counts from runSizes.
    const checkedSize = results.runSizes[costBasis.checkedRun];
    if (id === "C2" && supplied?.metrics)
      supplied = { ...supplied, metrics: { ...supplied.metrics, distinctContractCounts: checkedSize?.n } };
    if (id === "C8" && supplied && !supplied.notRun && rr.c8Starts.length) supplied = netPl[realRole] == null ? { notRun: `net P&L of the realistic run not read (netPl.${realRole})` } : { metrics: startDateMetrics(supplied, rr, netPl[realRole]) ?? undefined };
    let row;
    // Off the base costs without author_base, every cost-dependent check would
    // compare runs at different costs: not run (C2 and C3 do not depend on costs).
    const costDependent = ["C4", "C5", "C6", "C7", "C8", "C9"].includes(id);
    // The first run this check needs that is missing, not read or not at the realistic run's size.
    const gap = (OTHER_ROLES[id] ?? []).map((role) => {
      const size = results.runSizes[runs[role]];
      if (!runs[role]) return `${role} run missing`;
      if (size === undefined) return `contract counts of the ${role} run not read`;
      if (size.n !== 1) return `${role} run is not on fixed size (${size.n} contract counts)`;
      // PRD C2: the same count on every run a check uses.
      if (size.contracts !== checkedSize?.contracts) return `${role} run trades ${size.contracts} contracts per entry, the realistic run ${checkedSize?.contracts}`;
      return null;
    }).find(Boolean);
    if (id === "C9" && !rr.flags.author_has_stop) {
      row = { status: "n/a", outcome: "pass", reason: "no stop in the author settings" };
    } else if (id === "C8" && rr.c8Starts.length === 0) {
      // C2 accepts 24 months, so a shorter record is listed as not tested, never capped.
      row = { status: "skipped", outcome: "pass", reason: "record under 30 months: no later start leaves 24 months" };
    } else if (costDependent && costBasis.status !== "base") {
      row = notRun(`realistic run (author_base) missing (author run ${authorCostsMatchBase ? "without intra-minute stops" : "off base costs"})`);
    } else if (costDependent && exitMix.status === "changed") {
      // author_base is a different strategy, not the author's on other costs.
      row = notRun(
        "exit mix changed by re-costing (the realistic run, author_base, does not trade like the author run)",
      );
    } else if (gap) {
      row = notRun(gap);
    } else if (id === "C1") {
      if (!hasDescription(results.source)) {
        row = {
          status: "skipped",
          outcome: "pass",
          reason: "no source description supplied",
        };
      } else {
        const c1 = coreNotStated(results.ruleSheet, def);
        const { outcome, triggered } = applyRules(def.rules, c1);
        row = { status: "run", outcome, metrics: c1, triggered };
      }
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
              ...(supplied.totalNotPositive ? { totalNotPositive: true } : {}),
              ...(supplied.windowsOutside ? { windowsOutside: supplied.windowsOutside.map(({ name, start, end }) => ({ name, start, end })) } : {}),
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
      const bounds = [ciLow, ciHigh].every((b) => typeof b === "number");
      if (!bounds || point < ciLow || point > ciHigh) {
        row.unreliable = bounds
          ? "bootstrap interval excludes its own point estimate"
          : "bootstrap interval bound missing";
        // An unreliable interval caps C4, never rejects (no gate).
        row.outcome = "cap";
      }
    }
    // Coverage: without each run's backtest range TradeBlocks trims the flat
    // days to the common traded window, which is biased toward reject.
    if (id === "C4" && (row.status === "run" || row.status === "partial")) {
      const cov = results.c4Coverage;
      const why =
        cov == null
          ? "C4 coverage not recorded"
          : cov.source !== "caller"
            ? `C4 coverage source ${JSON.stringify(cov.source)}, not the backtest ranges: flat days limited to the common traded window`
            : null;
      if (why) {
        // At most cap: a reject cannot stand on a trimmed window either.
        row.outcome = "cap";
        row.reason = row.reason ? `${row.reason}; ${why}` : why;
      }
    }
    // R6: an explicit 0 slippage in the base scenario makes C7 meaningless.
    const zeroSlip = rr.zeroCostFields.filter((f) => /Slippage$/.test(f));
    if (id === "C7" && zeroSlip.length > 0 && row.status === "run") {
      if (SEVERITY[row.outcome] < SEVERITY.cap) row.outcome = "cap";
      row.reason = `slippage 0 in the base scenario: ${zeroSlip.join(", ")}`;
    }
    // Example costs say nothing about the user's own costs.
    if (id === "C7" && rr.costsExample && row.status === "run") {
      if (SEVERITY[row.outcome] < SEVERITY.cap) row.outcome = "cap";
      row.reason = row.reason ? `${row.reason}; ${COSTS_EXAMPLE}` : COSTS_EXAMPLE;
    }
    row.name = def.name;
    rows[id] = row;
  }

  // Data check (step 4): a C3 cap means the backtest is not the strategy. The triage stops
  // with unclear; later checks are logged, not counted, and never reject (Q6).
  // Only a triggered rule stops; a part that could not run (no naive run)
  // caps the verdict without stopping.
  let stoppedAt = null;
  if ((rows.C3.triggered ?? []).length > 0) {
    stoppedAt = "C3";
    for (const id of ORDER.slice(ORDER.indexOf("C3") + 1))
      rows[id].afterStop = true;
  }
  // Gate: a C4 reject stops the triage; later checks are logged, not counted.
  const gateFailed = stoppedAt === null && rows.C4.outcome === "reject";
  // The gate's hint (trade the naive version) only when that version made money.
  if (gateFailed && netPl.naive > 0) rows.C4.hint = `the naive version made ${fmt(netPl.naive, "USD")}; trade it instead of this strategy.`;
  if (gateFailed) {
    for (const id of ORDER.slice(ORDER.indexOf("C4") + 1))
      rows[id].afterGate = true;
  }
  const counted = ORDER.filter(
    (id) => !rows[id].afterGate && !rows[id].afterStop,
  ).map((id) => rows[id]);
  const capped =
    counted.some((r) => r.outcome === "cap") ||
    exitMix.status === "not_run";
  const verdict = counted.some((r) => r.outcome === "reject")
    ? "reject"
    : capped
      ? "unclear"
      : "continue";

  const notTested = ORDER.filter((id) =>
    ["not_run", "partial", "skipped"].includes(
      rows[id].status,
    ),
  ).map((id) => ({
    id,
    name: rows[id].name,
    status: rows[id].status,
    reason: rows[id].reason,
  }));
  // Off base costs or with a changed exit mix, C4-C9 are listed as not run already.
  if (exitMix.status === "not_run") {
    notTested.unshift({
      id: "exitMix",
      name: "realistic run trades like the author run",
      status: exitMix.status,
      reason: exitMix.reason,
    });
  }

  return {
    case: results.case ?? null,
    runAt: results.runAt ?? null,
    source: results.source ?? null,
    runs,
    blockId: results.blockId,
    costs: { base: rr.baseScenario ?? null, cost2x: rr.cost2xName ?? null, values: rr.costs ?? null },
    costsSource: rr.costsExample ? "example (not your own)" : "own",
    ruleSheet: results.ruleSheet ?? null,
    variantsTried: results.variantsTried ?? null,
    verdict,
    light: { continue: "green", unclear: "yellow", reject: "red" }[verdict],
    gateFailed,
    stoppedAt,
    costBasis,
    authorWithoutIntraMinute,
    exitMix,
    c4Coverage: results.c4Coverage ?? null,
    range: rr.range ?? null,
    returnBasis: rr.returnBasis ?? null,
    runSizes: results.runSizes,
    zeroCostFields: rr.zeroCostFields,
    checks: rows,
    notTested,
    thresholdsVersion: thresholds.version,
    thresholdsSha256,
    versions: {
      ...(results.versions ?? {}),
      skill: SKILL_VERSION,
      verdictScriptSha256: SCRIPT_SHA256,
    },
    captureIds: results.captureIds,
    runFolder: results.runFolder ?? null,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** One JSONL log line (R8): the full report. Deterministic: no clock; the caller supplies runAt. */
export const logLine = (report) => JSON.stringify(report);

function fmt(value, unit) {
  if (typeof value !== "number") return String(value);
  if (unit === "share") return `${(value * 100).toFixed(1)} %`;
  if (unit === "USD" || unit === "USD/day")
    return `${value.toFixed(2)} ${unit}`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// C6's 99 stands for a non-positive average month of the realistic run.
const c6Note = (id, metric, value) =>
  id === "C6" && metric === "worstStressLossInAvgMonths" && value === 99 ? " (average month not positive)" : "";

/** V1.1 (N27, N47): what Option Omega's percentage figures rest on; the checks use dollars at fixed size. */
function returnBasis(rb) {
  const yn = (v) => (v == null ? "not stated" : v ? "yes" : "no");
  const pct = rb?.allocationPercentage > 0;
  const n = rb?.maxContractsPerTrade;
  const sizing = pct ? `sizing by ${rb.allocationPercentage} % of account` : `${n ?? "?"} contract${n === 1 ? "" : "s"} per entry`;
  const funds = typeof rb?.startingFunds === "number" ? `$${rb.startingFunds.toLocaleString("en-US")}` : "not stated";
  return `Return basis: starting funds ${funds}${rb?.startingFundsAssumed ? " (assumed)" : ""}; ${sizing}; margin ignored: ${yn(rb?.ignoreMarginRequirements)}; compounding: ${rb ? yn(pct) : "not stated"}; ` +
    "all checks use dollars per trade at fixed size, so Option Omega's percentage figures depend on that basis.";
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
      "Stopped at the data check (step 4): the backtest does not trade the stated rules (C3). Fix the rules and rerun; this is not a verdict on the strategy.",
    );
  }
  lines.push(
    report.costBasis.status === "base"
      ? `Costs: checks read the realistic run ${report.costBasis.checkedRun} (the author's settings on the base cost scenario).`
      : `Costs: ${report.costBasis.reason}; verdict capped.`,
  );
  if (report.costsSource !== "own") {
    lines.push(
      `⚠️ ${COSTS_EXAMPLE}: the skill's example scenario, not your own costs; C7 capped unless it rejects. Give your own cost file for a verdict on your costs.`,
    );
  }
  if (report.zeroCostFields.length > 0) {
    lines.push(
      `Zero cost fields: ${report.zeroCostFields.join(", ")} (explicit 0 in the cost file).`,
    );
  }
  if (report.authorWithoutIntraMinute) {
    lines.push("Stops: author without intra-minute, check runs with (Option Omega's minute stops are too positive).");
  }
  if (report.exitMix.status === "changed") {
    lines.push(
      `Exit mix: re-costing changed the trade path (largest exit-reason share difference ${(report.exitMix.maxShareDiff * 100).toFixed(1)} %); the realistic run (author_base) is a different strategy, C4-C9 not run.`,
    );
  } else if (report.exitMix.status === "not_run") {
    lines.push(`Exit mix: ${report.exitMix.reason}; verdict capped.`);
  } else if (report.exitMix.status === "not_compared") {
    lines.push(`Exit mix: not compared: ${report.exitMix.reason}.`);
  }
  lines.push(returnBasis(report.returnBasis));
  if (report.c4Coverage?.source === "caller")
    lines.push(`C4 coverage: both runs' backtest range ${report.range.from} to ${report.range.through}; days without a position count as 0 only inside it.`);
  lines.push("");
  for (const id of ORDER) {
    const r = report.checks[id];
    const def = thresholds.checks[id];
    let detail;
    if (id === "C1" && r.status === "run") {
      // The core fields not stated by name (no score).
      const a = r.metrics.assumedCore;
      detail = a.length
        ? `core field${a.length > 1 ? "s" : ""} assumed: ${a.join(", ")} (cap if any core field is assumed)`
        : "no core field assumed (cap if any core field is assumed)";
    } else if (r.status === "run" || r.status === "partial") {
      detail = def.rules
        .map((rule) =>
          r.metrics[rule.metric] === null
            ? `${rule.metric} not run`
            : id === "C5" && rule.metric === "best10Share" && r.totalNotPositive
              ? `best10Share n/a (total not positive, counted above the cap) (${rule.outcome} if ${rule.op} ${fmt(rule.value, rule.unit)})`
              : `${rule.metric} ${fmt(r.metrics[rule.metric], rule.unit)}${c6Note(id, rule.metric, r.metrics[rule.metric])} (${rule.outcome} if ${rule.op} ${fmt(rule.value, rule.unit)})`,
        )
        .join("; ");
      if (r.status === "partial") detail += ` — ${r.reason}`;
    } else {
      detail = `${r.status.replace("_", " ")}: ${r.reason}`;
    }
    const tag = r.afterGate
      ? " [after failed gate, not counted]"
      : r.afterStop
        ? " [after the C3 stop, not counted]"
        : "";
    const flag = r.unreliable ? ` ⚠ ${r.unreliable}` : "";
    lines.push(
      `${id} ${r.name}: ${r.outcome.toUpperCase()}${tag} — ${detail}${flag}`,
    );
    if (r.hint) lines.push(`  Hint: ${r.hint}`);
    if (r.windowsOutside) lines.push(`  Outside the record, not counted: ${r.windowsOutside.map((x) => `${x.name} (${x.start} to ${x.end})`).join(", ")}.`);
  }
  if (report.ruleSheet) {
    lines.push("");
    lines.push(
      hasDescription(report.source)
        ? "Rule sheet (assumed fields marked *):"
        : "Rule sheet (from the author run's settings; no source to compare):",
    );
    // A core field marked n/a counts as assumed (C1 names it), so it is marked too.
    const assumedCore = report.checks.C1?.metrics?.assumedCore ?? [];
    for (const [field, entry] of Object.entries(report.ruleSheet)) {
      lines.push(
        `  ${entry.status === "assumed" || assumedCore.includes(field) ? "*" : " "} ${field}: ${entry.value}`,
      );
    }
  }
  lines.push("");
  // N48: never testable from a trade log (no historical volume, open interest or depth).
  const always = "liquidity at size (no historical volume, open interest or depth in TradeBlocks or Option Omega)";
  lines.push("Not tested: " + [...report.notTested.map((n) => `${n.id} (${n.reason})`), always].join("; "));
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
    const text = readFileSync(path, "utf8");
    return { text, json: JSON.parse(text) };
  } catch (error) {
    fail(reason, `${path}: ${error.message}`);
  }
}

export function run(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!["--results", "--log", "--summary"].includes(key) || argv[i + 1] === undefined)
      fail("USAGE", "triage-verdict.mjs --results <file> [--log <jsonl>] [--summary <file>]");
    args[key.slice(2)] = argv[i + 1];
  }
  if (!args.results) fail("USAGE", "--results is required");
  const { text, json: thresholds } = readJson(THRESHOLDS, "BAD_THRESHOLDS");
  const { json: results } = readJson(args.results, "BAD_RESULTS");
  const folder = dirname(args.results);
  const inFolder = (name, reason) => readJson(join(folder, name), reason).json;
  const report = evaluate(results, {
    runRequest: inFolder("run-request.json", "BAD_RUN_REQUEST"),
    pluginResult: inFolder("plugin-result.json", "BAD_PLUGIN_RESULT"),
    ruleSheet: inFolder("rule-sheet.json", "BAD_RULE_SHEET"),
  }, thresholds, { thresholdsSha256: createHash("sha256").update(text).digest("hex") });
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
