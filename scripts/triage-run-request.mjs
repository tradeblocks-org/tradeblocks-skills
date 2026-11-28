#!/usr/bin/env node
// Run request for is-this-backtest-lambo-or-lada (step 3).
//
// Reads the author run's Option Omega settings, the rule sheet (its stop mode)
// and the user's base cost scenario (through the local config) and writes the
// runs the triage still needs, each as exact field changes to the author run, to
// <run folder>/run-request.json, and per role the full Option Omega settings
// to run unchanged, <role>.settings.json (author included). The verdict script
// reads the flags, the costs, the date range and the run labels from
// run-request.json. The skill runs the settings files through the Option Omega
// MCP after the user's ok; the runs go into one TradeBlocks block and
// plugin-result.json is written.
//
//   node triage-run-request.mjs --settings <author settings JSON> \
//     --author-label <label> --run-folder <dir>
//
// The local config is found as in triage-config.mjs (default location,
// TRIAGE_CONFIG overrides); without a complete one it stops with SETUP_NEEDED.
//
// <author settings JSON> is the author run's Option Omega settings as a file (written
// from a description, or saved from Option Omega, e.g. a get_saved_backtest response). Prints JSON on stdout; errors: "REASON: detail", exit 1.

import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COST_FIELDS, loadScenarios, resolveConfig } from "./triage-config.mjs";
import { THRESHOLDS, hasDescription, validateRuleSheet } from "./triage-verdict.mjs";

const C1 = JSON.parse(readFileSync(THRESHOLDS, "utf8")).checks.C1;

function fail(reason, detail) {
  throw new Error(`${reason}: ${detail}`);
}

// ---------------------------------------------------------------------------
// Run request
// ---------------------------------------------------------------------------

/** Does Option Omega offer intra-minute stops for this exit group (SPX/SPY, every leg of the group 0 DTE)? */
export function intraMinuteOffered(p, group) {
  // No or empty legIds: Option Omega's single group over every leg.
  const ids = group?.legIds?.length ? group.legIds : null;
  const legs = (p.legs ?? []).filter((l) => !ids || ids.includes(l.id));
  return ["SPX", "SPY"].includes(p.underlying) && legs.length > 0 && legs.every((l) => l.daysToExpiration === 0);
}

/**
 * Does the exit group have a stop loss Option Omega accepts intra-minute for:
 * maxLoss (trailing included) or a stopLoss in a switched-on profit action?
 * An underlying-move or tested exit alone, and a time action's stopLoss alone,
 * are refused ("useIntraMinuteStop needs a stop loss (maxLoss, or a profit
 * action's stopLoss)", two validation runs).
 */
export function hasStop(g) {
  return typeof g.maxLoss === "number" || (g.useProfitActions === true && (g.profitActions ?? []).some((a) => a?.stopLoss != null));
}

/** A stop for C9: hasStop, or a stopLoss in a switched-on time action. */
export function hasC9Stop(g) {
  return hasStop(g) || (g.useTimeActions === true && (g.timeActions ?? []).some((a) => a?.stopLoss != null));
}

/**
 * Intra-minute stops per exit group: on wherever Option
 * Omega offers them and the group has a stop loss, read from the complete
 * settings, since a minute run is too positive; Option Omega refuses them
 * without one. Off for the author run when the rule sheet states that the
 * author runs minute stops.
 */
function intraMinute(p, on) {
  return (p.exitConditions ?? []).map((g) => {
    const want = on && hasStop(g);
    // An absent key is false: stating it would list a non-change.
    return intraMinuteOffered(p, g) && want !== (g.useIntraMinuteStop ?? false) ? { useIntraMinuteStop: want } : {};
  });
}

// A cost field the author's settings do not state is unknown, never 0.
function costsOf(p) {
  return Object.fromEntries(
    COST_FIELDS.map((f) => [f, typeof p[f] === "number" ? p[f] : null]),
  );
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The entries of `patch` whose value differs from `current`. */
function changedOnly(patch, current) {
  return Object.fromEntries(
    Object.entries(patch).filter(([k, v]) => !same(v, current[k])),
  );
}

const sameCosts = (a, b) =>
  COST_FIELDS.every((f) => a[f] !== null && Math.abs(a[f] - b[f]) < 1e-9);

// Naive run, fail closed: keep only the strategy's structure, expiry, strike
// rule, entry days and times and the date range; every other field is a lever
// and is switched off. Unit fields (…Type) stay; they mean nothing once the
// field they describe is off.
const KEEP_TOP = new Set([
  "underlying",
  "legs",
  "strikeOffsetType",
  "useExactDte",
  "roundStrikesToNearest",
  "rangeStart",
  "rangeEnd",
  "startingFunds",
  "entryTime",
  "additionalEntryTimes",
  "useFloatingEntryTime",
  "minEntryTime",
  "maxEntryTime",
  "weeklyEntries",
  "monthlyEntryDay",
  "monthlyEntryOrdinal",
  "specificEntryDays",
  "ignoreMarginRequirements",
  "exitConditions",
  ...COST_FIELDS,
]);
// Test-end rule, not a lever (PRD 2026-11-25): naive keeps the author's value, so both runs log the same open trades at rangeEnd.
const TEST_END = new Set(["closeOpenTradesAtTestCompletion"]);
// Quote-quality rule, not a market filter (PRD 2026-11-26): naive keeps the author's value, so both runs refuse the same quotes.
const QUOTE_QUALITY = new Set(["ignoreWideBidAskTrades"]);
// Text fields that only parametrise a feature switched off elsewhere (naive); strategy-as-built shows them with that feature.
const HARMLESS_TEXT = new Set([
  "breakoutCondition",
  "openingRangeBreakoutEndTime",
]);
// Text fields whose null value disables a filter (blackoutDays: null is "no blackout days", as Option Omega stores it).
const NULLABLE_TEXT = new Set([
  "entrySmaCondition",
  "entryIntradayEmaCondition",
  "blackoutDays",
]);
const KEEP_EXIT = new Set(["id", "name", "legIds"]);
const isUnit = (k) => /Type$/.test(k);

/** The "off" value of a field, or undefined when it cannot be switched off safely. */
function offValue(value) {
  if (typeof value === "boolean") return false;
  if (typeof value === "number") return null;
  if (Array.isArray(value)) return [];
  if (value === null) return null;
  if (typeof value === "object") return null;
  return undefined;
}

/** Field changes that turn the author run into its naive version. */
function naiveChanges(p) {
  const set = {};
  const reviewByHand = [];
  for (const [k, v] of Object.entries(p)) {
    if (KEEP_TOP.has(k) || TEST_END.has(k) || QUOTE_QUALITY.has(k) || isUnit(k) || HARMLESS_TEXT.has(k)) continue;
    if (NULLABLE_TEXT.has(k)) {
      set[k] = null;
      continue;
    }
    const off = offValue(v);
    if (off === undefined) reviewByHand.push(k);
    else set[k] = off;
  }
  // Fixed size: one constant contract count per entry, no allocation sizing.
  set.maxContractsPerTrade = p.maxContractsPerTrade || 1;
  set.allocationPercentage = 0; // OO accepts 0 only with margin requirements ignored
  set.ignoreMarginRequirements = true;
  const exitConditions = (p.exitConditions ?? []).map((group) => {
    const g = {};
    for (const [k, v] of Object.entries(group)) {
      if (KEEP_EXIT.has(k) || isUnit(k)) continue;
      g[k] = typeof v === "string" ? null : (offValue(v) ?? null);
    }
    // Defaults the author may have left out: state them, so nothing is implied.
    for (const k of ["maxProfit", "maxLoss"]) if (!(k in g)) g[k] = null;
    for (const k of [
      "useIntraMinuteStop",
      "useProfitActions",
      "useTimeActions",
      "isTrailingStopLoss",
    ]) {
      if (!(k in g)) g[k] = false;
    }
    return g;
  });
  return { set, exitConditions, reviewByHand: reviewByHand.sort() };
}

const ref = (l) => (l.metricType === "ChildLeg" ? l.childMetricType : l.metricType);
// Sold minus bought strike where the settings fix it (null otherwise); a delta pair by |delta|, nearer the money is larger.
function soldMinusBought(s, b) {
  if (b.parentId === s.id && b.childMetricType === "ParentOffset") return -b.parentStrikeOffset;
  if (s.parentId === b.id && s.childMetricType === "ParentOffset") return s.parentStrikeOffset;
  if (s.metricType === "StrikeOffset" && b.metricType === "StrikeOffset") return s.strikeOffset - b.strikeOffset;
  if (ref(s) === "Delta" && ref(b) === "Delta") return (s.type === "Put" ? 1 : -1) * (Math.abs(s.delta) - Math.abs(b.delta));
  return null;
}

/** Spreads (a sold and a bought leg of one type) with kind credit, debit or null (not determinable). */
export function spreads(p) {
  const byId = Object.fromEntries(p.legs.map((l) => [l.id, l]));
  const pairs = p.legs.filter((l) => l.childMetricType === "ParentOffset" && byId[l.parentId]?.type === l.type && byId[l.parentId].buySell !== l.buySell)
    .map((l) => [byId[l.parentId], l]);
  const paired = new Set(pairs.flat());
  for (const type of ["Put", "Call"]) {
    const rest = p.legs.filter((l) => l.type === type && !paired.has(l));
    const [s, b] = ["Sell", "Buy"].map((side) => rest.filter((l) => l.buySell === side));
    if (s.length && b.length) pairs.push(s.length === 1 && b.length === 1 ? [s[0], b[0]] : [null, null, type]);
  }
  return pairs.map(([x, y, type]) => {
    const [short, long] = x?.buySell === "Sell" ? [x, y] : [y, x];
    const d = short ? soldMinusBought(short, long) : null;
    const t = type ?? short.type;
    return { type: t, short, long, kind: d === null || Number.isNaN(d) ? null : (t === "Put" ? d > 0 : d < 0) ? "credit" : "debit" };
  });
}

// The field each metricType reads (Option Omega's run_backtest schema); a child leg by its childMetricType.
const STRIKE = { Delta: "delta", Percentage: "percentage", FixedPrice: "fixedPrice", StrikeOffset: "strikeOffset", SpreadPremium: "spreadPremium" };
const CHILD = { ParentOffset: "parentStrikeOffset", FixedPrice: "fixedPrice", Delta: "delta" };
/** What the settings lack for a run that matches the user's answers (fail closed; empty when complete). */
export function settingsGaps(settings) {
  const p = settings.parameters ?? settings, legs = Array.isArray(p.legs) ? p.legs : [], gaps = [];
  if (!legs.length) gaps.push("no legs");
  const ids = new Set(legs.map((l) => l.id));
  for (const l of legs) {
    const child = l.metricType === "ChildLeg", [kind, map, t] = child ? ["childMetricType", CHILD, l.childMetricType] : ["metricType", STRIKE, l.metricType];
    if (child && !ids.has(l.parentId)) gaps.push(`leg ${l.id}: parentId ${JSON.stringify(l.parentId ?? null)} is not a leg`);
    if (!map[t]) gaps.push(`leg ${l.id}: ${kind} missing or unknown (${JSON.stringify(t ?? null)})`);
    else if (typeof l[map[t]] !== "number") gaps.push(`leg ${l.id}: no numeric ${map[t]} for ${kind} ${t}`);
    if (typeof l.daysToExpiration !== "number") gaps.push(`leg ${l.id}: no numeric daysToExpiration`);
  }
  if (!p.entryTime && !(p.useFloatingEntryTime && p.minEntryTime && p.maxEntryTime))
    gaps.push("no entryTime and no floating entry window (useFloatingEntryTime with minEntryTime and maxEntryTime)");
  // Option Omega refuses a run without starting funds above 0.
  if (!(p.startingFunds > 0)) gaps.push("no startingFunds above 0");
  return gaps;
}

// A description build uses $500,000, marked assumed, unless the source states the amount.
export const DEFAULT_STARTING_FUNDS = 500000;
/** Dollar amounts a quote names: "$100,000", "100000", "100k", "1.5 million". */
function amounts(q) {
  const mult = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6 };
  return [...String(q).matchAll(/(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|thousand|mm|m|million)?\b/gi)]
    .map(([, n, u]) => Number(n.replace(/,/g, "")) * (u ? mult[u.toLowerCase()] : 1));
}
/** The account amounts (1,000 or more: "1 contract per entry" states the size, not the funds) a stated `sizing` quote, found literally in the description, names. */
export function statedFunds(rs, source) {
  const q = rs?.sizing?.quote;
  return rs?.sizing?.status === "stated" && typeof q === "string" && q.trim() !== "" && String(source?.description ?? "").includes(q) ? amounts(q).filter((n) => n >= 1000) : [];
}

/** The Percentage maxLoss a stated stop quote with one multiple names (from-description rule 3): loss wording ("stop loss" and "stoploss" included) N x 100, credit or price wording (N-1) x 100; null when it names none or several. */
export function stopFromQuote(rs) {
  const q = rs?.stop?.status === "stated" ? String(rs.stop.quote ?? "") : "", n = [...new Set([...q.matchAll(/(\d+(?:\.\d+)?)\s*(?:x\b|×|times\b)/gi)].map((m) => Number(m[1])))];
  if (n.length !== 1) return null;
  if (/(?:\b|stop)los(?:s|ses|e|es|ing|t)\b/i.test(q)) return n[0] * 100;
  if (/credit|premium|price|spread/i.test(q)) return (n[0] - 1) * 100;
  fail("BAD_RULE_SHEET", `stop is stated with ${JSON.stringify(q)}: a multiple without loss, credit, premium, price or spread wording is not stated; mark stop assumed (from-description rule 3)`);
}

/** author_base is the realistic run unless the author run is on the base costs and intra-minute. */
export const realisticIsBase = (flags) => !flags.author_costs_match_base || flags.author_without_intra_minute;

/**
 * The runs the triage needs, with the flags, cost identity and date range the
 * verdict reads: the author run itself (its stops may change), author_base,
 * naive and cost_2x.
 */
export function runRequest(settings, scenarios, authorLabel, ruleSheet = {}, source = null) {
  const p = settings.parameters ?? settings;
  // Every run keeps the author's Option Omega date range; C4 passes it to
  // TradeBlocks as both runs' coverage, so it is required (O3).
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!DATE.test(p.rangeStart ?? "") || !DATE.test(p.rangeEnd ?? ""))
    fail("BAD_SETTINGS", "rangeStart and rangeEnd (YYYY-MM-DD) are required: ask the user for the date range");
  // A credit structure needs each long leg further out (from-description.md rule 5).
  if (/credit|iron condor/i.test(ruleSheet.structure?.value ?? "") && !/debit|reverse/i.test(ruleSheet.structure.value))
    for (const s of spreads(p).filter((s) => s.kind === "debit"))
      fail("INVERTED_SPREAD", `${s.long.id} (${s.type}) sits on the inner side of ${s.short.id}, which builds a debit spread; for the credit structure "${ruleSheet.structure.value}" the long leg is further out of the money`);
  const authorCosts = costsOf(p);
  const offered = (p.exitConditions ?? []).some((g) => intraMinuteOffered(p, g) && hasStop(g));
  // A saved backtest's own useIntraMinuteStop per exit group is the author's stop mode.
  const saved = source?.built_from === "saved backtest";
  const minuteStated = saved ? (p.exitConditions ?? []).some((g) => intraMinuteOffered(p, g) && hasStop(g) && !g.useIntraMinuteStop)
    : ruleSheet.stop_mode?.status === "stated" && ruleSheet.stop_mode?.value === "minute";
  const flags = {
    author_costs_match_base: sameCosts(authorCosts, scenarios.base),
    // The author run without intra-minute stops while every check run has them.
    author_without_intra_minute: offered && minuteStated,
    // V1.1 C9: a stop loss in any exit group (maxLoss, or a profit or time action's stopLoss).
    author_has_stop: (p.exitConditions ?? []).some(hasC9Stop),
  };
  const runs = [];
  const checkStops = intraMinute(p, true);
  // The author run reproduces the author; it runs like every role.
  runs.push({
    role: "author",
    label: authorLabel,
    set: {},
    exitConditions: saved ? [] : intraMinute(p, !minuteStated),
    why: saved ? "the saved backtest's own intra-minute setting per exit group (the author's stop mode)"
      : minuteStated ? "the rule sheet states minute stops: the author run without intra-minute stops"
      : "intra-minute stops where Option Omega offers them (the rule sheet does not state minute stops)",
  });
  // Every run a check reads but C3's author run starts from the author's rules at the base costs.
  const base = { ...scenarios.base };

  // The realistic run is always intra-minute, so author_base also runs for a minute author on the base costs.
  if (realisticIsBase(flags)) {
    runs.push({
      role: "author_base",
      label: `${authorLabel} base-costs`,
        set: base,
      exitConditions: checkStops,
      why: `${flags.author_costs_match_base ? "the author run is without intra-minute stops" : `author costs ${COST_FIELDS.some((f) => authorCosts[f] !== null) ? COST_FIELDS.map((f) => `${f} ${authorCosts[f] ?? "not stated"}`).join(", ") : "not stated (Option Omega's defaults)"} differ from the base scenario ${scenarios.baseName}`}; with intra-minute stops, the realistic run, which every check but C3 reads`,
    });
  }
  // naive has no stop left, so no intra-minute stop either.
  const n = naiveChanges(p);
  runs.push({
    role: "naive",
    label: `${authorLabel} naive`,
    set: { ...base, ...n.set },
    exitConditions: n.exitConditions,
    reviewByHand: n.reviewByHand,
    why: "author run minus every optional lever (profit target, stops, time and tested exits, entry filters, blackout days, re-entry, sizing), held to expiry, at base costs",
  });
  runs.push({
    role: "cost_2x",
    label: `${authorLabel} slip2x`,
    set: { ...scenarios.cost2x },
    exitConditions: checkStops,
    why: `author rules at ${scenarios.cost2xName}`,
  });
  // V1.1 C9: the realistic run (author_base when it runs, else author) with only
  // its stop values scaled; same costs, type, unit and intra-minute setting.
  if (flags.author_has_stop) {
    const checked = runs.find((r) => r.role === "author_base") ?? runs[0];
    for (const [role, f] of Object.entries(STOP_FACTORS))
      runs.push({
        role,
        label: `${authorLabel} ${role.replace("_", "-")}`,
            set: { ...checked.set },
        exitConditions: (p.exitConditions ?? []).map((g, i) => ({ ...checked.exitConditions[i], ...scaledStops(g, f) })),
        why: `${checked.role} run with every stop value × ${f} (maxLoss incl. trailing, switched-on profit- and time-action stopLoss), nothing else changed (C9)`,
      });
  }
  // List only the fields that really change, so the request is exact.
  for (const r of runs) {
    r.set = changedOnly(r.set, p);
    r.exitConditions = r.exitConditions.map((e, i) =>
      changedOnly(e, p.exitConditions[i] ?? {}),
    );
    while (r.exitConditions.length && !Object.keys(r.exitConditions.at(-1)).length) r.exitConditions.pop();
    if (!r.exitConditions.length) delete r.exitConditions;
  }
  // R6: an explicit 0 is allowed but named (a slippage of 0 caps C7); the
  // 2x run mirrors the base (0 x 2 = 0, base fees), so only base fields.
  const zeroCostFields = COST_FIELDS.filter((f) => scenarios.base[f] === 0).map((f) => `base.${f}`);
  const c8Starts = laterStarts(p.rangeStart, p.rangeEnd);
  return {
    flags,
    baseScenario: scenarios.baseName,
    cost2xName: scenarios.cost2xName,
    // The shipped example instead of the user's own costs: summary, log and C7 say so.
    costsExample: scenarios.example === true,
    // The exact cost values used, for the log.
    costs: { base: scenarios.base, cost2x: scenarios.cost2x },
    zeroCostFields,
    range: { from: p.rangeStart, through: p.rangeEnd },
    // V1.1 C8: the later starts step 6 reads; the return basis the summary names.
    c8Starts,
    // The C8 run_sql on the realistic run, finished but for the block id the import gives.
    c8Sql: c8Sql(c8Starts, realisticIsBase(flags) ? `${authorLabel} base-costs` : authorLabel),
    // C3 (PRD C3 row): missing rule days from naive when the author skips rule days on purpose (entry filters, blackout days), else from the author run; a calendar check, independent of costs.
    c3MissingDaysRun: topLevers(p).filters.length || isSet(p.blackoutDays) ? "naive" : "author",
    // The get_rule_calendar arguments besides block and strategy, passed unchanged (blind public #4 misread the weekday numbers).
    ...c3Rule(p),
    returnBasis: {
      ...Object.fromEntries(["startingFunds", "allocationPercentage", "maxContractsPerTrade", "ignoreMarginRequirements"].map((k) => [k, p[k] ?? null])),
      // The default of a description build that does not state the amount is marked assumed.
      startingFundsAssumed: source?.built_from === "description" && !statedFunds(ruleSheet, source).includes(p.startingFunds),
    },
    runs,
  };
}

const WEEKDAY = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5 };
/** C3's rule from the settings: weekdays 1 = Monday … 5 = Friday (all five or none = "daily"), the front leg's DTE, exact or first at least, first to last entry time. */
function c3Rule(p) {
  const days = (p.weeklyEntries ?? []).filter(isSet).map((d) => WEEKDAY[d]);
  const times = (p.useFloatingEntryTime ? [p.minEntryTime, p.maxEntryTime] : [p.entryTime, ...(p.additionalEntryTimes ?? [])]).filter(Boolean).map((t) => t.slice(0, 5)).sort();
  if (isSet(p.monthlyEntryDay) || isSet(p.specificEntryDays) || days.includes(undefined))
    return { c3Rule: null, c3RuleNotRun: "monthly or listed entry days: get_rule_calendar takes weekdays only" };
  return { c3Rule: {
    rule: { entryWeekdays: days.length === 0 || days.length === 5 ? "daily" : [...new Set(days)].sort(), dte: Math.min(...p.legs.map((l) => l.daysToExpiration)),
      selection: p.useExactDte ? "exact" : "firstAtLeast", entryWindow: { from: times[0], to: times.at(-1) } },
    dateRange: { start: p.rangeStart, end: p.rangeEnd }, recordEnd: p.rangeEnd,
  } };
}
/** V1.1 C8: net P&L of the trades opened on or after each later start (pl is net of fees; get_statistics startDate filters by close date). */
function c8Sql(starts, label) {
  if (!starts.length) return null;
  const values = starts.map((d) => `(DATE '${d}')`).join(", ");
  // Columns as check-results.json C8 starts reads them: the rows go in unchanged.
  return `SELECT strftime(s.d, '%Y-%m-%d') AS "startDate", COALESCE(SUM(t.pl), 0) AS "netPl" FROM (VALUES ${values}) s(d) LEFT JOIN trades.trade_data t ON t.block_id = '<block_id>' AND t.strategy = '${label.replace(/'/g, "''")}' AND t.date_opened >= s.d GROUP BY s.d ORDER BY s.d`;
}

// V1.1 C9: stop neighbours. The exact product is sent (Option Omega takes any number).
export const STOP_FACTORS = { stop_tight: 0.75, stop_wide: 1.25 };
const times = (v, f) => Math.round(v * f * 1e9) / 1e9;
/** The group's stop values × f: maxLoss (trailing included) and the stopLoss of every switched-on profit or time action. */
export function scaledStops(g, f) {
  const out = {};
  if (typeof g.maxLoss === "number") out.maxLoss = times(g.maxLoss, f);
  for (const [k, on] of [["profitActions", "useProfitActions"], ["timeActions", "useTimeActions"]])
    if (g[on] === true && (g[k] ?? []).some((a) => typeof a?.stopLoss === "number"))
      out[k] = g[k].map((a) => (typeof a?.stopLoss === "number" ? { ...a, stopLoss: times(a.stopLoss, f) } : a));
  return out;
}

/** `date` plus `n` calendar months, the day clamped to the month's last day. */
export function addMonths(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  const t = y * 12 + m - 1 + n, last = new Date(Date.UTC(Math.floor(t / 12), (t % 12) + 1, 0)).getUTCDate();
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
/** V1.1 C8: rangeStart + 6, 12, 18 … months while at least 24 months remain. */
export function laterStarts(from, through) {
  const out = [];
  for (let k = 6; addMonths(addMonths(from, k), 24) <= through; k += 6) out.push(addMonths(from, k));
  return out;
}

// ---------------------------------------------------------------------------
// Pre-run gate ("No guessing")
// ---------------------------------------------------------------------------

/**
 * Settings built from a description need every core field stated, each with a
 * quote found literally in the description; otherwise NOT_BUILDABLE with the
 * fixed message the skill shows word for word (no score).
 */
export function gate({ source, rule_sheet: rs }, def) {
  if (source?.built_from === "description" && !(typeof source.description === "string" && source.description.trim()))
    fail("BAD_RULE_SHEET", "built_from description needs source.description as text; a sha256 cannot be checked against a quote");
  if (!hasDescription(source)) return;
  if (!["description", "saved backtest"].includes(source.built_from))
    fail("BAD_RULE_SHEET", `source.built_from must be "description" or "saved backtest", not ${JSON.stringify(source.built_from ?? null)}`);
  if (source.built_from !== "description") return;
  validateRuleSheet(rs, def);
  // The stated stop mode decides the author run's stops: exact value, literal quote.
  const sm = rs.stop_mode;
  if (sm?.status === "stated" && !(["intra-minute", "minute"].includes(sm.value) && typeof sm.quote === "string" && sm.quote.trim() && String(source.description).includes(sm.quote)))
    fail("BAD_RULE_SHEET", `stop_mode is stated as ${JSON.stringify(sm.value ?? null)} with quote ${JSON.stringify(sm.quote ?? null)}: a stated stop_mode is "intra-minute" or "minute", with a quote found literally in source.description`);
  for (const f of def.coreFields) {
    const q = rs[f]?.quote;
    if (rs[f]?.status === "stated" && !(typeof q === "string" && q.trim() && String(source.description).includes(q)))
      fail("BAD_RULE_SHEET", `${f} is stated but its quote is not in source.description: ${JSON.stringify(q ?? null)}`);
  }
  // Not stated (assumed, n/a or missing) is missing: a description build needs every core field.
  const missing = def.coreFields.filter((f) => rs[f]?.status !== "stated");
  if (missing.length)
    fail("NOT_BUILDABLE", [
      "Cannot build the author's strategy with confidence from this description.",
      `Core fields not stated: ${missing.join(", ")}.`,
      "Please supply:",
      ...missing.map((f) => { const w = rs[f]?.quote ?? rs[f]?.reason; return `- ${f}: ${def.ask[f]}${w ? ` Source says: "${w}"` : ""}`; }),
      "No Option Omega backtest was run.",
    ].join("\n"));
}

// ---------------------------------------------------------------------------
// Settings files (one per role, run unchanged)
// ---------------------------------------------------------------------------

/** The author settings with exactly the run's listed changes. */
export function applyRun(author, run) {
  const applied = structuredClone(author);
  Object.assign(applied, run.set);
  (run.exitConditions ?? []).forEach((g, i) => Object.assign(applied.exitConditions[i], g));
  return applied;
}

/** Per role (the author included) the settings to run unchanged. */
export const settingsFiles = (author, runs) =>
  Object.fromEntries(runs.map((r) => [r.role, applyRun(author, r)]));

// ---------------------------------------------------------------------------
// strategy-as-built.md: the author settings in Option Omega's run-summary layout, for the pre-run question
// ---------------------------------------------------------------------------

const COVERED = new Set([...KEEP_TOP, ...QUOTE_QUALITY, "allocationPercentage", "maxContractsPerTrade", "capitalPerContract", "blackoutDays"]);
const isSet = (v) => v != null && v !== false && v !== "" && v !== "None" && !(Array.isArray(v) && !v.length);
// F2: Option Omega's entry filters (run_backtest schema); a field that only qualifies a filter counts with it, and not at all while that filter is off.
const ENTRY_FILTER = /^(entry(Vix)?(Min|Max)|entry(Sma|IntradayEma)Condition$|useOpeningRangeBreakout$|(min|max)EntryPremium$|(min|max)ShortLongRatio$)/;
const QUALIFIES = { entrySmaLength: ["entrySmaCondition"], entrySmaLengthLesser: ["entrySmaCondition"], entryIntradayEmaLength: ["entryIntradayEmaCondition"],
  entryIntradayEmaLengthLesser: ["entryIntradayEmaCondition"], useOpeningRangeBreakoutHighLow: ["useOpeningRangeBreakout"],
  breakoutCondition: ["useOpeningRangeBreakout"], openingRangeBreakoutEndTime: ["useOpeningRangeBreakout"], isEntryPremiumDebit: ["minEntryPremium", "maxEntryPremium"] };
// Re-entry fields act only with a re-entry condition.
const REENTRY = /^(reentry|maxDailyReentries$)/;
/** The set top-level fields strategy-as-built does not show elsewhere: entry filters, re-entry, other switches. */
function topLevers(p) {
  const out = { filters: [], reentry: [], other: [] };
  for (const [k, v] of Object.entries(p)) {
    if (COVERED.has(k) || isUnit(k) || !isSet(v)) continue;
    if (k in QUALIFIES) { if (QUALIFIES[k].some((f) => isSet(p[f]))) out.filters.push([k, v]); }
    else if (ENTRY_FILTER.test(k)) out.filters.push([k, v]);
    else if (REENTRY.test(k)) { if (isSet(p.reentryConditions)) out.reentry.push([k, v]); }
    else out.other.push([k, v]);
  }
  return out;
}
const NOT_LEVER = /^(id|name|legIds|maxLoss|maxProfit|lossType|profitType|isMaxLossPerLeg|maxLossLegs|isTrailingStopLoss|useIntraMinuteStop|useProfitActions|useTimeActions|profitActions|timeActions|exitTime)$/;
// A third entry true: the value is already text (a filter with its unit).
const kv = (pairs) => (pairs.length ? pairs.map(([k, v, text]) => `${k} ${text ? v : JSON.stringify(v)}`).join(", ") : "none");
const amount = (v, unit) => (unit === "Percentage" ? `${v}%` : `${v}${unit ? ` ${unit}` : ""}`);

// A set top-level move or gap filter's number reads only with its unit field (entryMoveType, entryGapType, entryVixMoveType, entryVixGapType).
const unitOf = (k) => (/^entry.*(Move|Gap)/.test(k) ? `entry${/Vix/.test(k) ? "Vix" : ""}${/Gap/.test(k) ? "Gap" : "Move"}Type` : null);
const withUnit = (p) => ([k, v]) => { const u = unitOf(k); return [k, u ? `${JSON.stringify(v)} (${u} ${p[u] == null ? "not stated" : JSON.stringify(p[u])})` : v, !!u]; };

/** The author settings in plain words, one renderer for strategy-as-built.md and the rule sheet written for a saved backtest. */
function plain(p) {
  const byId = Object.fromEntries(p.legs.map((l) => [l.id, l])), tag = (l) => `${l.buySell[0]} ${l.type[0]}`, side = (v) => `${Math.abs(v)} ${v >= 0 ? "above" : "below"}`;
  const name = (l) => (l ? (p.legs.filter((o) => tag(o) === tag(l)).length > 1 ? `${tag(l)} ${l.id}` : tag(l)) : "?"), names = (ids) => ids.map((id) => name(byId[id])).join(", ");
  const strike = (l) => ({
    Delta: () => `${l.delta}Δ`, Percentage: () => `${l.percentage}% from the price`, FixedPrice: () => `price $${l.fixedPrice}`,
    StrikeOffset: () => `${side(l.strikeOffset)} ${p.strikeOffsetType ?? "CurrentPrice"}`, SpreadPremium: () => `spread premium $${l.spreadPremium}`,
    ChildLeg: () => ({ ParentOffset: `${side(l.parentStrikeOffset)} ${name(byId[l.parentId])}`, Delta: `${l.delta}Δ`, FixedPrice: `price $${l.fixedPrice}` })[l.childMetricType],
  })[l.metricType]?.() ?? `metricType ${l.metricType}`;
  const top = topLevers(p);
  return {
    legs: p.legs.map((l) => `${name(l)} ${l.quantity ?? 1} · ${strike(l)}${l.isExactOffset ? ", exact offset" : ""} · ${l.daysToExpiration} DTE`),
    pairs: spreads(p).map((s) => `${s.type.toLowerCase()} ${s.short ? `spread ${name(s.short)} / ${name(s.long)}` : "legs"}: ${s.kind ?? "credit/debit: not determinable"}`),
    days: `${p.weeklyEntries?.filter(isSet).length ? p.weeklyEntries.join(", ") : isSet(p.monthlyEntryDay) ? `monthly, ${p.monthlyEntryDay} no. ${p.monthlyEntryOrdinal}` : p.specificEntryDays ? `on ${p.specificEntryDays.split(",").length} listed dates` : "every trading day"}${p.blackoutDays ? `, except ${p.blackoutDays.split(",").length} blackout days` : ""}`,
    times: p.useFloatingEntryTime ? `between ${p.minEntryTime} and ${p.maxEntryTime}` : [p.entryTime, ...(p.additionalEntryTimes ?? [])].map((t) => t?.slice(0, 5)).join(", "),
    dte: `${[...new Set(p.legs.map((l) => l.daysToExpiration))].join(", ")}, ${p.useExactDte ? "exact" : "not exact"}`,
    allocation: `${p.allocationPercentage ?? 0}%${p.ignoreMarginRequirements ? ", margin ignored" : p.capitalPerContract ? `, 1 contract per $${p.capitalPerContract}` : ""}`,
    contracts: p.ignoreMarginRequirements ? `${p.maxContractsPerTrade} per entry, fixed` : p.maxContractsPerTrade ? `at most ${p.maxContractsPerTrade}` : "no cap",
    exits: (p.exitConditions ?? []).map((g) => ({
      head: `${g.name ?? "All legs"}${g.legIds?.length ? ` (${names(g.legIds)})` : ""}`,
      profit: `profit target ${typeof g.maxProfit === "number" ? amount(g.maxProfit, g.profitType) : "none"}`,
      stop: `stop loss ${typeof g.maxLoss === "number" ? `${amount(g.maxLoss, g.lossType)}${g.isMaxLossPerLeg ? `, per leg (${names(g.maxLossLegs ?? [])})` : ""}${g.isTrailingStopLoss ? ", trailing" : ""}${g.useIntraMinuteStop ? ", intra-minute" : ""}` : "none"}`,
      time: `exit time ${g.exitTime ? g.exitTime.slice(0, 5) : "none (otherwise held to expiry)"}`,
      extra: [g.useProfitActions && `profitActions ${JSON.stringify(g.profitActions ?? [])}`, g.useTimeActions && `timeActions ${JSON.stringify(g.timeActions ?? [])}`,
        ...Object.entries(g).filter(([k, v]) => !NOT_LEVER.test(k) && isSet(v)).map((e) => kv([e])),
        // Intra-minute from an action's stop (no maxLoss): say so after it.
        g.useIntraMinuteStop && typeof g.maxLoss !== "number" && "intra-minute"].filter(Boolean),
    })),
    filters: kv(top.filters.map(withUnit(p))), reentry: kv(top.reentry), other: kv(top.other), hasOther: top.other.length > 0,
    fees: `Opening fees: ${cost(p, "openingFees")}; closing fees: ${cost(p, "closingFees")}`,
    slippage: `Entry slippage: ${cost(p, "entrySlippage")}; exit slippage: ${cost(p, "exitSlippage")}; stop slippage: ${cost(p, "stopLossSlippage")}`,
  };
}
const cost = (p, f) => (typeof p[f] === "number" ? `$${p[f]}` : "not stated");

/** Legs, Entry, Exit, Misc as Option Omega's run summary shows them, other set fields as `key value`; rule-sheet fields marked `assumed` are marked. */
export function strategyAsBuilt(p, sheet = {}, rr = {}, source) {
  // A core field not stated (n/a included) counts as assumed, only when C1 runs: with a source description.
  const core = hasDescription(source) ? C1.coreFields : [], assumed = (k) => sheet[k]?.status === "assumed" || (core.includes(k) && sheet[k]?.status !== "stated");
  const mark = (...ks) => { const a = ks.filter(assumed); return a.length ? ` *(assumed: ${a.join(", ")})*` : ""; };
  const topAssumed = [...["underlying", "date_range", "sizing"].filter(assumed), ...(rr.returnBasis?.startingFundsAssumed ? ["starting funds"] : [])];
  const x = plain(p);
  const exits = x.exits.map((g) => `- ${g.head}: ${g.profit}; ${g.stop}; ${g.time}${g.extra.length ? `; ${g.extra.join(", ")}` : ""}`);
  return [`# Strategy as built`, ``, `${p.underlying} · ${p.rangeStart} to ${p.rangeEnd} · starting funds $${p.startingFunds}${topAssumed.length ? ` *(assumed: ${topAssumed.join(", ")})*` : ""}`, ``,
    `## Legs`, ...x.legs.map((l) => `- ${l}${mark("legs", "dte")}`),
    ...(p.roundStrikesToNearest > 0 ? [`- Strikes rounded to the nearest ${p.roundStrikesToNearest}`] : []),
    x.pairs.length ? `- Spreads: ${x.pairs.join("; ")}${mark("structure")}` : `- Structure: ${sheet.structure?.value ?? "see legs"}${mark("structure")}`,
    // Blind run r57: OO aims the spread's net credit at it (median 1.45 for 1.50).
    ...(p.legs.some((l) => l.metricType === "SpreadPremium") ? ["- Spread premium: Option Omega targets the whole spread's net credit (short minus long leg) with it, not the short leg's own price; filled credits vary around that target."] : []),
    `## Entry`, `- Time: ${x.times}${mark("entry_time")}`, `- Days: ${x.days}${mark("days_traded")}`, `- DTE: ${x.dte}`,
    `- Allocation: ${x.allocation}${mark("sizing")}`,
    `- Contracts per trade: ${x.contracts}`, `- Filters: ${x.filters}${mark("entry_filters")}`, `- Re-entry: ${x.reentry}${mark("reentry")}`,
    `## Exit${mark("stop", "stop_mode", "exit")}`, ...exits,
    `## Misc${mark("fills")}`, `- ${x.fees} (${COST_FIELDS.some((f) => typeof p[f] === "number") ? "the author's own" : "Option Omega's defaults in the author run"})`, `- ${x.slippage}`,
    `- The checks run at ${rr.costsExample ? "example costs (not your own)" : `your ${rr.baseScenario} costs`}`,
    ...(isSet(p.ignoreWideBidAskTrades) ? [`- Quote quality: ignoreWideBidAskTrades ${p.ignoreWideBidAskTrades} (kept in every run)`] : []),
    ...(x.hasOther ? [`- Other settings: ${x.other}`] : []),
    ...(rr.runs ?? []).filter((r) => r.role in STOP_FACTORS).map((r) => `- ${r.role} (C9): stop values × ${STOP_FACTORS[r.role]}: ${(r.exitConditions ?? []).map((g) => [g.maxLoss != null && `maxLoss ${g.maxLoss}`, ...["profit", "time"].flatMap((k) => (g[`${k}Actions`] ?? []).filter((a) => a?.stopLoss != null).map((a) => `${k}-action stopLoss ${a.stopLoss}`))].filter(Boolean).join(", ")).filter(Boolean).join("; ")}`),
  ].join("\n") + "\n";
}

/** PRD R1 for a saved backtest without a description: the 14 rule fields from its settings, all n/a (nothing to compare; C1 skipped). */
export function savedRuleSheet(p, ref) {
  const x = plain(p), groups = (k) => x.exits.map((g) => `${g.head}: ${g[k]}`).join("; ") || "none";
  const value = {
    underlying: p.underlying, structure: x.pairs.join("; ") || x.legs.join("; "), legs: x.legs.join("; "), dte: x.dte, entry_time: x.times,
    days_traded: x.days, stop: groups("stop"), exit: x.exits.map((g) => `${g.head}: ${g.profit}; ${g.time}`).join("; ") || "none",
    date_range: `${p.rangeStart} to ${p.rangeEnd}`, entry_filters: x.filters, reentry: x.reentry,
    sizing: `allocation ${x.allocation}; contracts per trade ${x.contracts}`, fills: `${x.fees}; ${x.slippage}`,
    // The saved setting is the author's; groups saved differently are named each.
    stop_mode: ((m) => (new Set(m.map((e) => e[1])).size > 1 ? m.map((e) => e.join(": ")).join("; ") : m[0]?.[1] ?? "no stop"))(
      x.exits.flatMap((e, i) => (hasStop(p.exitConditions[i]) ? [[e.head, p.exitConditions[i].useIntraMinuteStop ? "intra-minute" : "minute"]] : []))),
  };
  return { source: { ref, built_from: "saved backtest" }, rule_sheet: Object.fromEntries(Object.entries(value).map(([f, v]) => [f, { value: v, status: "n/a" }])), variants_tried: null };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const ASK = "write the user's answers into source.settings.json, then rerun step 3";
const readIn = (folder, name, reason) => {
  try {
    return JSON.parse(readFileSync(join(folder, name), "utf8"));
  } catch (error) {
    fail(reason, `${join(folder, name)}: ${error.message}`);
  }
};

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) {
      fail(
        "USAGE",
        "triage-run-request.mjs --settings <file> --author-label <label> --run-folder <dir> [--saved-backtest <name>]",
      );
    }
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

export function main(argv, env = process.env) {
  const a = args(argv);
  if (!a["author-label"] || !a["run-folder"])
    fail("USAGE", "--settings, --author-label and --run-folder are required");
  const folder = a["run-folder"], sheetPath = join(folder, "rule-sheet.json");
  if ("saved-backtest" in a) {
    // PRD R1 for a saved backtest without a description: this script writes the sheet; one the agent wrote with a description is never replaced.
    if (!a.settings) fail("USAGE", "--settings is required");
    if (existsSync(sheetPath) && hasDescription(readIn(folder, "rule-sheet.json", "BAD_RULE_SHEET").source))
      fail("BAD_RULE_SHEET", `${sheetPath} has a source description: rerun without --saved-backtest`);
    mkdirSync(folder, { recursive: true });
    const s = JSON.parse(readFileSync(a.settings, "utf8"));
    writeFileSync(sheetPath, JSON.stringify(savedRuleSheet(s.parameters ?? s, a["saved-backtest"]), null, 2) + "\n");
  } else if (!existsSync(sheetPath))
    fail("BAD_RULE_SHEET", `${sheetPath} missing: write it in step 2 (description), or pass --saved-backtest "<name>" for a saved backtest without a description`);
  // The gate reads the rule sheet before anything else is written; its stop mode decides the author run's stops.
  const sheet = readIn(folder, "rule-sheet.json", "BAD_RULE_SHEET");
  gate(sheet, C1);
  if (!a.settings) fail("USAGE", "--settings is required");
  const config = resolveConfig(env);
  if (config.status !== "ready")
    fail("SETUP_NEEDED", `${config.reason} (template: ${config.template}; check with triage-config.mjs)`);
  const scenarios = loadScenarios(config);
  const settings = JSON.parse(readFileSync(a.settings, "utf8"));
  // A value the source does not state never reaches a run (blind run r57 took Option Omega's UI default).
  const p = settings.parameters ?? settings;
  const named = sheet.source?.built_from === "description" ? statedFunds(sheet.rule_sheet, sheet.source) : null;
  if (named?.length && !named.includes(p.startingFunds))
    fail("BAD_SETTINGS", `startingFunds ${p.startingFunds ?? "not set"} is not the amount the sizing quote states (${named.join(", ")}); ${ASK}`);
  if (named && !named.length) p.startingFunds = DEFAULT_STARTING_FUNDS;
  if (named) {
    // A description build fixes the expiry choice (C3 selection) and its stop from the quote, never Option Omega's default or a guess.
    if (typeof p.useExactDte !== "boolean") fail("BAD_SETTINGS", `useExactDte not set (true for 0 DTE or an exact DTE the source states, else false; from-description rule 2); ${ASK}`);
    const want = stopFromQuote(sheet.rule_sheet), off = (p.exitConditions ?? []).filter((g) => typeof g.maxLoss === "number" && g.lossType === "Percentage" && g.maxLoss !== want);
    if (want !== null && off.length) fail("BAD_SETTINGS", `maxLoss ${off.map((g) => g.maxLoss).join(", ")} is not the Percentage stop the stop quote states (${want}; from-description rule 3); ${ASK}`);
  }
  // Every source: a run that does not match the rules (OO defaults or a refusal) is never written.
  const gaps = settingsGaps(settings);
  if (gaps.length) fail("BAD_SETTINGS", `${gaps.join("; ")}; ${ASK}`);
  const out = runRequest(settings, scenarios, a["author-label"], sheet.rule_sheet ?? {}, sheet.source);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "run-request.json"), JSON.stringify(out, null, 2) + "\n");
  // Settings files only when no field needs a check by hand.
  const review = out.runs.filter((r) => r.reviewByHand?.length);
  if (review.length)
    fail("REVIEW_BY_HAND", `${review.map((r) => `${r.role}: ${r.reviewByHand.join(", ")}`).join("; ")}: no settings files written; check these author settings by hand`);
  const files = settingsFiles(settings.parameters ?? settings, out.runs);
  for (const [role, p] of Object.entries(files))
    writeFileSync(join(folder, `${role}.settings.json`), JSON.stringify(p, null, 2) + "\n");
  writeFileSync(join(folder, "strategy-as-built.md"), strategyAsBuilt(files.author, sheet.rule_sheet ?? {}, out, sheet.source));
  return out;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.stdout.write(
      JSON.stringify(main(process.argv.slice(2)), null, 2) + "\n",
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
