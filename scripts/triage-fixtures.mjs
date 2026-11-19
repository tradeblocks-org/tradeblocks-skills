#!/usr/bin/env node
// Synthetic Option Omega trade logs for the triage calibration cases A1-A5.
//
//   node triage-fixtures.mjs [outDir]      default: tests/fixtures/triage
//
// Writes <outDir>/<case>/tradelog.csv (all runs of one triage in one log, one
// Strategy label per run, as one TradeBlocks block) and <outDir>/<case>/triage.json
// (the manifest). Deterministic: a fixed mulberry32 seed per case, no clock.
// The numbers are synthetic; they model no real strategy, account or cost.

import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const iso = (d) => d.toISOString().slice(0, 10);
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const round2 = (x) => Math.round(x * 100) / 100;

function nthMonday(year, month, n) {
  let d = `${year}-${String(month).padStart(2, "0")}-01`;
  while (weekday(d) !== 1) d = addDays(d, 1);
  return addDays(d, 7 * (n - 1));
}
function lastMonday(year, month) {
  let d = addDays(`${year}-${String(month + 1).padStart(2, "0")}-01`, -1);
  if (month === 12) d = `${year}-12-31`;
  while (weekday(d) !== 1) d = addDays(d, -1);
  return d;
}

/** NYSE holidays that fall on a Monday (incl. Sunday holidays observed Monday). */
export function isMondayHoliday(date) {
  if (weekday(date) !== 1) return false;
  const y = Number(date.slice(0, 4));
  const floating = [
    nthMonday(y, 1, 3),
    nthMonday(y, 2, 3),
    lastMonday(y, 5),
    nthMonday(y, 9, 1),
  ];
  if (floating.includes(date)) return true;
  const fixed = ["01-01", "07-04", "12-25", ...(y >= 2022 ? ["06-19"] : [])];
  return fixed.some((md) => {
    const day = `${y}-${md}`;
    return day === date || (weekday(day) === 0 && addDays(day, 1) === date);
  });
}

/** Monday sessions from `from` through `to`. */
export function mondays(from, to) {
  const out = [];
  let d = from;
  while (weekday(d) !== 1) d = addDays(d, 1);
  for (; d <= to; d = addDays(d, 7)) if (!isMondayHoliday(d)) out.push(d);
  return out;
}

function legs(expiry, shortStrike, width, credit) {
  const m = MONTHS[Number(expiry.slice(5, 7)) - 1];
  const day = Number(expiry.slice(8, 10));
  const s = round2(credit / 100 + 1);
  const l = round2(1);
  return `1 ${m} ${day} ${shortStrike} P STO ${s.toFixed(2)} | 1 ${m} ${day} ${shortStrike - width} P BTO ${l.toFixed(2)}`;
}

function row(t, strategy) {
  return [
    t.open,
    "09:35:00",
    t.close,
    "16:00:00",
    legs(t.expiry, t.strike, 50, t.credit),
    round2(t.credit).toFixed(2),
    1,
    round2(t.pl).toFixed(2),
    strategy,
  ].join(",");
}

const HEADER =
  "Date Opened,Time Opened,Date Closed,Time Closed,Legs,Premium,No. of Contracts,P/L,Strategy";

// ---------------------------------------------------------------------------
// Trade models (1 lot, 50-wide SPX put spread, dollars)
// ---------------------------------------------------------------------------

/**
 * One trade per entry date. `edge` shifts the expiry outcome: 0 = zero
 * expected P&L at expiry, > 0 = positive. `mae` is the maximum adverse
 * excursion in multiples of the credit, used by stop rules.
 */
function baseTrades(rand, dates, { edge, expiry }) {
  return dates.map((open, i) => {
    const credit = 120 + 60 * rand();
    const pWin = 0.8;
    const loss = (credit * pWin) / (1 - pWin) - edge / (1 - pWin);
    const win = rand() < pWin;
    const pl = win
      ? credit * (0.7 + 0.3 * rand())
      : -loss * (0.6 + 0.8 * rand());
    const mae = win ? 3 * rand() ** 2 : 1 + 4 * rand();
    const exp = expiry(open, i);
    return {
      open,
      close: exp,
      expiry: exp,
      strike: 4000 + 10 * i,
      credit,
      pl,
      mae,
    };
  });
}

/**
 * Stop at `stopPct` % of credit: a trade whose MAE reaches it loses exactly
 * that. `maeOf` optionally replaces the trade's MAE (per-cell path noise).
 */
function withStop(trades, stopPct, maeOf = (t) => t.mae) {
  if (stopPct === null) return trades.map((t) => ({ ...t }));
  return trades.map((t, i) =>
    maeOf(t, i) >= stopPct / 100
      ? { ...t, pl: -(t.credit * stopPct) / 100, close: t.open }
      : { ...t },
  );
}

const withCost = (trades, perTrade) =>
  trades.map((t) => ({ ...t, pl: t.pl - perTrade }));
const exact7 = (open) => addDays(open, 7);

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const STATED = (value) => ({ value, status: "stated" });
const ASSUMED = (value) => ({ value, status: "assumed" });

function ruleSheet(overrides = {}) {
  return {
    underlying: STATED("SPX"),
    structure: STATED("put credit spread"),
    legs: STATED("short 20 delta, 50 wide"),
    dte: STATED(7),
    entry_time: STATED("09:35"),
    stop: STATED("none"),
    exit: STATED("hold to expiry"),
    entry_filters: STATED("none"),
    days_traded: STATED("Monday"),
    reentry: STATED("none"),
    sizing: STATED("1 lot"),
    fills: ASSUMED("OO default"),
    date_range: STATED("2022-06 to 2025-12"),
    ...overrides,
  };
}

const NA = (value) => ({ value, status: "n/a" });
/** Rule sheet from the settings alone (no source to compare): every field n/a. */
function settingsSheet(range) {
  return {
    underlying: NA("SPX"),
    structure: NA("put credit spread"),
    legs: NA("short put, 50 wide"),
    dte: NA(7),
    entry_time: NA("09:35"),
    stop: NA("none"),
    exit: NA("hold to expiry"),
    entry_filters: NA("none"),
    days_traded: NA("Monday"),
    reentry: NA("none"),
    sizing: NA("1 lot"),
    fills: NA("synthetic"),
    date_range: NA(`${range[0]} to ${range[1]}`),
  };
}

function ooSettings(range, extra = {}) {
  return {
    useExactDte: true,
    entryDays: ["Monday"],
    dte: 7,
    entryTime: "09:35",
    additionalEntryTimes: [],
    useIntraMinuteStop: false,
    entryFilters: [],
    rangeStart: range[0],
    rangeEnd: range[1],
    ...extra,
  };
}

function manifest(id, runs, extra = {}) {
  return {
    block_id: `triage-${id.toLowerCase()}`,
    runs,
    rule_sheet: settingsSheet(RANGE),
    oo_settings: ooSettings(RANGE),
    author_costs_match_base: true,
    variants_tried: 1,
    costs: {
      scenario: "synthetic",
      note: "synthetic example; real triages take costs from the local config",
    },
    ...extra,
  };
}

const RANGE = ["2022-06-06", "2025-12-29"];

export const CASES = {
  // Overfit winner: best of a 35-cell grid (delta x stop) on zero-edge noise.
  A1() {
    const rand = mulberry32(101);
    const dates = mondays(...RANGE);
    const base = baseTrades(rand, dates, { edge: 0, expiry: exact7 });
    const cells = [];
    let cell = 0;
    for (const delta of [10, 15, 20, 25, 30]) {
      for (const stop of [100, 150, 200, 250, 300, 350, 400]) {
        const scale = delta / 20;
        const scaled = base.map((t) => ({
          ...t,
          credit: t.credit * scale,
          pl: t.pl * scale,
        }));
        // Each cell sees its own intraday paths: the grid spread is pure noise.
        const path = mulberry32(1000 + cell++);
        const mae = scaled.map((t) =>
          t.pl > 0 ? 3 * path() ** 2 : 1 + 4 * path(),
        );
        const trades = withStop(scaled, stop, (_, i) => mae[i]);
        const total = trades.reduce((s, t) => s + t.pl, 0);
        cells.push({ delta, stop, trades, total });
      }
    }
    // Deterministic pick: highest total, ties to the smaller delta, then smaller stop.
    cells.sort(
      (a, b) => b.total - a.total || a.delta - b.delta || a.stop - b.stop,
    );
    const best = cells[0];
    const author = `A1-d${best.delta}-s${best.stop}`;
    return {
      rows: [
        ...best.trades.map((t) => row(t, author)),
        ...base.map((t) => row(t, "A1-naive")),
        ...withCost(best.trades, 10).map((t) => row(t, "A1-cost2x")),
      ],
      manifest: manifest(
        "A1",
        { author, naive: "A1-naive", cost_2x: "A1-cost2x" },
        {
          variants_tried: 35,
          expected_checks: {
            C1: "pass",
            C2: "pass",
            C3: "pass",
            C4: "cap",
            C5: "reject",
            C6: "reject",
            C7: "reject",
            C8: "pass",
          },
          grid: {
            delta: [10, 15, 20, 25, 30],
            stopPct: [100, 150, 200, 250, 300, 350, 400],
            pick: { delta: best.delta, stop: best.stop },
          },
        },
      ),
      expect: ["reject", "unclear"],
    };
  },

  // Noise filter: the base rule on a random half of its days.
  A2() {
    const rand = mulberry32(202);
    const dates = mondays(...RANGE);
    const naive = baseTrades(rand, dates, { edge: 60, expiry: exact7 });
    const coin = mulberry32(2020);
    const author = naive.filter(() => coin() < 0.5);
    return {
      rows: [
        ...author.map((t) => row(t, "A2-author")),
        ...naive.map((t) => row(t, "A2-naive")),
        ...withCost(author, 10).map((t) => row(t, "A2-cost2x")),
      ],
      manifest: manifest(
        "A2",
        { author: "A2-author", naive: "A2-naive", cost_2x: "A2-cost2x" },
        {
          oo_settings: ooSettings(RANGE, {
            entryFilters: ["synthetic coin-flip filter"],
          }),
          // C4 decides; C5-C8 run after the failed gate and are not counted.
          expected_checks: { C1: "pass", C2: "cap", C3: "pass", C4: "reject" },
        },
      ),
      expect: ["reject"],
    };
  },

  // Control: naive structure plus a filter that skips planted losing days.
  A3() {
    return controlCase("A3", 303, {
      expectedChecks: {
        C1: "pass",
        C2: "pass",
        C3: "pass",
        C4: "pass",
        C5: "pass",
        C6: "pass",
        C7: "pass",
        C8: "pass",
      },
    });
  },

  // Mistranslation: A3 with the stop type changed and the stop marked assumed.
  A4() {
    return controlCase("A4", 303, {
      stopPct: 300,
      ruleSheet: { stop: ASSUMED("300 % of credit") },
      expectedChecks: {
        ...{
          C1: "pass",
          C2: "pass",
          C3: "pass",
          C4: "pass",
          C5: "pass",
          C6: "pass",
          C7: "pass",
          C8: "pass",
        },
        C1: "cap",
      },
    });
  },

  // Expiry trap: "7 DTE Mondays" from 2016 without exact DTE; only every other
  // Friday listed, so entries land at 11 or 18 DTE.
  A5() {
    const listed = [];
    for (let d = "2016-01-08"; d <= "2019-02-28"; d = addDays(d, 14))
      listed.push(d);
    const firstAtLeast7 = (open) =>
      listed.find((f) => (Date.parse(f) - Date.parse(open)) / 864e5 >= 7);
    return controlCase("A5", 505, {
      range: ["2016-01-04", "2018-12-31"],
      expiry: firstAtLeast7,
      ruleSheet: { date_range: STATED("2016-01 to 2018-12") },
      exactDte: false,
      // C3 decides and stops the triage at step 2; C4-C8 are logged, not counted.
      expectedChecks: { C1: "pass", C2: "pass", C3: "cap" },
    });
  },
};

function controlCase(
  id,
  seed,
  {
    stopPct = null,
    range = RANGE,
    expiry = exact7,
    ruleSheet: rs = {},
    exactDte = true,
    expectedChecks,
  },
) {
  const rand = mulberry32(seed);
  const dates = mondays(...range);
  const naive = baseTrades(rand, dates, { edge: 60, expiry });
  // Planted filter: about one day in five is a "filter-off" day with a large loss.
  const flag = mulberry32(seed + 1);
  const filterOff = new Set(dates.filter(() => flag() < 0.2));
  for (const t of naive) {
    if (filterOff.has(t.open)) t.pl = -(260 + 120 * rand());
  }
  const author = withStop(
    naive.filter((t) => !filterOff.has(t.open)),
    stopPct,
  );
  return {
    rows: [
      ...author.map((t) => row(t, `${id}-author`)),
      ...naive.map((t) => row(t, `${id}-naive`)),
      ...withCost(author, 10).map((t) => row(t, `${id}-cost2x`)),
    ],
    manifest: manifest(
      id,
      { author: `${id}-author`, naive: `${id}-naive`, cost_2x: `${id}-cost2x` },
      {
        source: {
          ref: `Synthetic case ${id}`,
          description:
            `Synthetic source for case ${id}: sell a 7 DTE SPX put spread every Monday ` +
            "at 09:35, skip filter-off days, hold to expiry.",
        },
        rule_sheet: ruleSheet({
          entry_filters: STATED("skip filter-off days"),
          ...rs,
        }),
        oo_settings: ooSettings(range, {
          useExactDte: exactDte,
          entryFilters: ["skip filter-off days"],
        }),
        expected_checks: expectedChecks,
      },
    ),
    expect: id === "A3" ? ["continue"] : ["unclear"],
  };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export function generate(outDir) {
  const written = [];
  for (const [id, build] of Object.entries(CASES)) {
    const { rows, manifest: m, expect } = build();
    const dir = join(outDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "tradelog.csv"),
      [HEADER, ...rows].join("\n") + "\n",
    );
    writeFileSync(
      join(dir, "triage.json"),
      JSON.stringify({ ...m, expected_verdict: expect }, null, 2) + "\n",
    );
    written.push({ id, trades: rows.length });
  }
  return written;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const here = dirname(fileURLToPath(import.meta.url));
  const out =
    process.argv[2] ?? join(here, "..", "tests", "fixtures", "triage");
  process.stdout.write(JSON.stringify(generate(out)) + "\n");
}
