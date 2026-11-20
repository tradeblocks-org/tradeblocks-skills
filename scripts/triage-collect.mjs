#!/usr/bin/env node
// Developer tool: regenerate the frozen check results of the triage
// calibration cases from a running TradeBlocks MCP server (HTTP transport).
// It makes exactly the TradeBlocks calls SKILL.md prescribes and writes
// <case>/check-results.json next to each case's tradelog.csv and triage.json.
// The skill itself does not use this script.
//
//   TRIAGE_TB_URL=<http://host:port/mcp> \
//   [TRIAGE_TB_IMPORT_ROOT=<fixtures dir as the server sees it>] \
//   node triage-collect.mjs [fixturesDir] [--tb-version <label>]
//
// With TRIAGE_TB_IMPORT_ROOT set, each case's tradelog.csv is imported first
// (block name = the manifest's block_id); without it the blocks must exist.
// Results depend on the TradeBlocks version: record it with --tb-version.

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Minimal MCP client (streamable HTTP, JSON or SSE replies)
// ---------------------------------------------------------------------------

export function mcpClient(url) {
  let sid = null;
  let id = 0;
  const headers = () => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(sid ? { "mcp-session-id": sid } : {}),
  });
  async function post(body) {
    const res = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    sid = res.headers.get("mcp-session-id") ?? sid;
    return res;
  }
  async function rpc(method, params) {
    const res = await post({ jsonrpc: "2.0", id: ++id, method, params });
    const text = await res.text();
    const json = text.trimStart().startsWith("{")
      ? text
      : text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5))
          .pop();
    if (!json)
      throw new Error(
        `MCP_REPLY: empty reply to ${method} (HTTP ${res.status})`,
      );
    const msg = JSON.parse(json);
    if (msg.error)
      throw new Error(`MCP_ERROR: ${method}: ${JSON.stringify(msg.error)}`);
    return msg.result;
  }
  return {
    async connect() {
      await rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "triage-collect", version: "1" },
      });
      await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    },
    async call(name, args) {
      const r = await rpc("tools/call", { name, arguments: args });
      if (r.isError)
        throw new Error(`TOOL_ERROR: ${name}: ${r.content?.[0]?.text}`);
      return r.structuredContent;
    },
  };
}

// ---------------------------------------------------------------------------
// Metrics per SKILL.md
// ---------------------------------------------------------------------------

function monthsCovered(periods) {
  const [y1, m1] = periods[0].period.split("-").map(Number);
  const [y2, m2] = periods[periods.length - 1].period.split("-").map(Number);
  return (y2 - y1) * 12 + (m2 - m1) + 1;
}

const WEEKDAYS = {
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
};
const hhmm = (t) => t.slice(0, 5);

/**
 * get_rule_calendar arguments from the author run's Option Omega settings:
 * the rule, the entry window from the first to the last entry time, and the
 * author's own OO date range (so rule days before the first or after the
 * last entry are counted as missing).
 */
export function ruleCalendarArgs(oo) {
  const times = [oo.entryTime, ...(oo.additionalEntryTimes ?? [])]
    .filter(Boolean)
    .map(hhmm)
    .sort();
  const rule = {
    entryWeekdays:
      (oo.entryDays ?? []).length === 0
        ? "daily"
        : oo.entryDays.map((d) => WEEKDAYS[d]),
    dte: oo.dte,
    selection: oo.useExactDte ? "exact" : "firstAtLeast",
    ...(times.length > 0
      ? { entryWindow: { from: times[0], to: times[times.length - 1] } }
      : {}),
  };
  const dateRange =
    oo.rangeStart && oo.rangeEnd
      ? { start: oo.rangeStart, end: oo.rangeEnd }
      : undefined;
  // Option Omega reports no close after rangeEnd: an entry that would expire
  // later is left open and out of the log, so it is not a missing rule day.
  return {
    rule,
    ...(dateRange ? { dateRange } : {}),
    ...(oo.rangeEnd ? { recordEnd: oo.rangeEnd } : {}),
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRange = (r) =>
  r &&
  DATE.test(r.from ?? "") &&
  DATE.test(r.through ?? "") &&
  r.from <= r.through;

/**
 * C4 coverage: each run's own backtest range (manifest run_ranges, from the
 * Option Omega settings or the capture's daily log). A is the checked run
 * (author_base when present), B the naive run. Without both ranges the
 * coverage is omitted and TradeBlocks trims to the common traded window.
 */
export function c4CoverageArgs(manifest) {
  const ranges = manifest.run_ranges ?? {};
  const a = ranges[manifest.runs.author_base ? "author_base" : "author"];
  const b = ranges.naive;
  if (!isRange(a) || !isRange(b)) return undefined;
  return {
    A: { from: a.from, through: a.through },
    B: { from: b.from, through: b.through },
  };
}

/**
 * C6 metrics from per-window author results ({name, result: {trades, netPl}}
 * or result null when the call failed). A failed window makes C6 not run;
 * a window without author trades does not count as in the record.
 */
export function stressMetrics(windows, authorNetPl, months) {
  const failed = windows.find((w) => w.result === null);
  if (failed)
    return { notRun: `stress window ${failed.name} could not be read` };
  const inRecord = windows.filter((w) => w.result.trades > 0);
  const worst = Math.min(0, ...inRecord.map((w) => w.result.netPl));
  const avgMonth = authorNetPl / months;
  return {
    metrics: {
      stressPeriodsInRecord: inRecord.length,
      worstStressLossInAvgMonths:
        worst >= 0 ? 0 : avgMonth > 0 ? -worst / avgMonth : 99,
    },
  };
}

/**
 * The TradeBlocks calls of SKILL.md for one manifest. The checked author run
 * is author_base when the manifest has one (R6), else author.
 */
export async function collectCase(tb, manifest, thresholds) {
  const block = manifest.block_id;
  const { naive, cost_2x: cost2x, minute_stop: minuteStop } = manifest.runs;
  const author = manifest.runs.author_base ?? manifest.runs.author;
  const stats = (strategy, extra = {}) =>
    tb.call("get_statistics", {
      blockId: block,
      strategy,
      riskFreeRateAnnualPct: 0,
      ...extra,
    });
  const quote = (v) => `'${String(v).replace(/'/g, "''")}'`;
  const checks = {};
  let c4Coverage;

  // Contract counts per run label (fixed size on every run a check uses) and,
  // with author_base, the exit-reason mix of author and author_base.
  const perRun = await tb.call("run_sql", {
    query:
      "SELECT strategy, COUNT(DISTINCT num_contracts) AS n FROM trades.trade_data " +
      `WHERE block_id = ${quote(block)} GROUP BY strategy`,
  });
  const runSizes = Object.fromEntries(
    (perRun.rows ?? perRun).map((r) => [r.strategy, Number(r.n)]),
  );
  let exitMix;
  if (manifest.runs.author_base) {
    const reasons = async (label) => {
      const res = await tb.call("run_sql", {
        query:
          "SELECT reason_for_close AS reason, COUNT(*) AS n FROM trades.trade_data " +
          `WHERE block_id = ${quote(block)} AND strategy = ${quote(label)} GROUP BY reason_for_close`,
      });
      return Object.fromEntries(
        (res.rows ?? res).map((r) => [r.reason ?? "unknown", Number(r.n)]),
      );
    };
    exitMix = {
      author: await reasons(manifest.runs.author),
      authorBase: await reasons(manifest.runs.author_base),
    };
  }

  // C2: sample and fixed size
  const authorStats = await stats(author, { topDays: [1, 5, 10] });
  const monthly = await tb.call("get_period_returns", {
    blockId: block,
    strategy: author,
    period: "monthly",
  });
  const months = monthsCovered(monthly.periods);
  const sizes = await tb.call("run_sql", {
    query:
      "SELECT COUNT(DISTINCT num_contracts) AS n FROM trades.trade_data " +
      `WHERE block_id = ${quote(block)} AND strategy = ${quote(author)}`,
  });
  checks.C2 = {
    metrics: {
      trades: authorStats.stats.totalTrades,
      months,
      distinctContractCounts: Number((sizes.rows ?? sizes)[0].n),
    },
  };

  // C3: DTE from the author run; missing rule days from the naive run when the
  // author uses entry filters (no naive run -> that part not run).
  const oo = manifest.oo_settings;
  const args = ruleCalendarArgs(oo);
  const rcAuthor = await tb.call("get_rule_calendar", {
    blockId: block,
    strategy: author,
    ...args,
  });
  const filtered = (oo.entryFilters ?? []).length > 0;
  // A server without recordEnd counts the open last entry as missing.
  const missingShare = (rc) =>
    args.recordEnd && !rc.unobservableRuleDays ? null : rc.missingRuleDays.share;
  const noRecordEnd =
    "missing rule days need get_rule_calendar recordEnd (TradeBlocks too old)";
  let missingRuleDayShare = missingShare(rcAuthor);
  let notRunReason = missingRuleDayShare === null ? noRecordEnd : undefined;
  if (filtered) {
    if (naive) {
      missingRuleDayShare = missingShare(
        await tb.call("get_rule_calendar", {
          blockId: block,
          strategy: naive,
          ...args,
        }),
      );
      notRunReason = missingRuleDayShare === null ? noRecordEnd : undefined;
    } else {
      missingRuleDayShare = null;
      notRunReason =
        "missing rule days need the naive run (author uses entry filters)";
    }
  }
  checks.C3 = {
    metrics: {
      maxYearDteMismatchShare: rcAuthor.dte.maxYearMismatchShare,
      missingRuleDayShare,
    },
    ...(notRunReason ? { notRunReason } : {}),
  };

  // C4
  if (naive) {
    const coverage = c4CoverageArgs(manifest);
    // A refusal by the tool (e.g. a trade outside its run's coverage) means C4
    // could not run: record TradeBlocks' message instead of aborting.
    const prefix = "TOOL_ERROR: paired_bootstrap_comparison: ";
    const pb = await tb
      .call("paired_bootstrap_comparison", {
        blockId: block,
        strategyA: author,
        strategyB: naive,
        unobservedDays: "zero",
        grid: "xnys",
        ...(coverage ? { coverage } : {}),
        seed: thresholds.bootstrap.seed,
        resamples: thresholds.bootstrap.resamples,
        ciLevel: thresholds.bootstrap.ciLevel,
      })
      .catch((error) => {
        if (!error.message.startsWith(prefix)) throw error;
        checks.C4 = {
          notRun: `TradeBlocks refused the comparison: ${error.message.slice(prefix.length)}`,
        };
        return null;
      });
    if (pb) {
      checks.C4 = {
        metrics: { point: pb.point, ciLow: pb.ci.low, ciHigh: pb.ci.high },
      };
    }
    if (pb?.coverageSource) {
      c4Coverage = {
        source: pb.coverageSource,
        ...(pb.coverage?.A ? { A: pb.coverage.A } : {}),
        ...(pb.coverage?.B ? { B: pb.coverage.B } : {}),
        ...(pb.flatWindowTrimmed
          ? { flatWindowTrimmed: pb.flatWindowTrimmed }
          : {}),
      };
    }
  }

  // C5
  const pwb = Object.fromEntries(
    authorStats.plWithoutBestDays.map((r) => [r.n, r]),
  );
  checks.C5 = {
    metrics: {
      plWithoutBest5: pwb[5].pl,
      best10Share: pwb[10].shareOfTotal ?? 1,
      positiveYearShare: authorStats.positiveYearShare,
    },
  };

  // C6: TradeBlocks' own stress windows, author P&L per window.
  const st = await tb.call("stress_test", { blockId: block });
  const windows = [];
  for (const w of st.scenarios.filter(
    (x) => !x.isCustom && !x.name.endsWith("_recovery"),
  )) {
    const s = await stats(author, {
      startDate: w.dateRange.start,
      endDate: w.dateRange.end,
    }).catch(() => null);
    windows.push({
      name: w.name,
      // null = the call failed; no structured result = no author trades in the window.
      result:
        s === null
          ? null
          : s?.stats
            ? { trades: s.stats.totalTrades, netPl: s.stats.netPl }
            : { trades: 0, netPl: 0 },
    });
  }
  checks.C6 = stressMetrics(windows, authorStats.stats.netPl, months);

  // C7
  if (cost2x) {
    const c = (await stats(cost2x)).stats.netPl;
    const base = authorStats.stats.netPl;
    checks.C7 = {
      metrics: { cost2xPl: c, cost2xKeepShare: base > 0 ? c / base : 0 },
    };
  }

  // C8
  if (minuteStop) {
    const m = (await stats(minuteStop)).stats.netPl;
    const base = authorStats.stats.netPl;
    checks.C8 = {
      metrics: {
        minuteStopPl: m,
        minuteStopDropShare: base > 0 ? 1 - m / base : 1,
      },
    };
  }

  return { checks, runSizes, exitMix, c4Coverage };
}

/** check-results.json for one manifest, from the collected checks. */
export function resultsFor(id, manifest, collected, tbVersion) {
  const { checks, runSizes, exitMix, c4Coverage } = collected;
  const src = manifest.source;
  return {
    _source:
      `Frozen check results: the synthetic trade log of this case imported into TradeBlocks ${tbVersion} ` +
      "and read with the TradeBlocks calls in SKILL.md (scripts/triage-collect.mjs).",
    case: id,
    runAt: "2026-11-19T00:00:00Z",
    source: src
      ? {
          ref: src.ref,
          ...(src.description ? { description: src.description } : {}),
        }
      : null,
    ruleSheet: manifest.rule_sheet,
    blockId: manifest.block_id,
    runs: manifest.runs,
    // Cost scenario names come from the local config, never from the manifest.
    costs: null,
    costsSha256: manifest.costs_sha256 ?? null,
    zeroCostFields: manifest.zero_cost_fields ?? [],
    // From the run request; the synthetic fixtures use their own costs.
    costsExample: manifest.costs_example ?? false,
    runSizes,
    ...(exitMix ? { exitMix } : {}),
    ...(c4Coverage ? { c4Coverage } : {}),
    variantsTried: manifest.variants_tried,
    authorUsesIntraMinuteStops: manifest.oo_settings.useIntraMinuteStop,
    authorCostsMatchBase: manifest.author_costs_match_base,
    checks,
    versions: { tradeblocks: tbVersion },
    // A run's identity is its capture id; null for a role without one (CSV import).
    captureIds: Object.fromEntries(
      Object.keys(manifest.runs).map((role) => [role, manifest.capture_ids?.[role] ?? null]),
    ),
    runFolder: null,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  const url = process.env.TRIAGE_TB_URL;
  if (!url)
    throw new Error("USAGE: set TRIAGE_TB_URL to the TradeBlocks MCP endpoint");
  const versionAt = argv.indexOf("--tb-version");
  const tbVersion = versionAt >= 0 ? argv[versionAt + 1] : "unknown";
  const positional = argv.filter(
    (a, i) => !a.startsWith("--") && argv[i - 1] !== "--tb-version",
  );
  const fixtures =
    positional[0] ?? join(here, "..", "tests", "fixtures", "triage");
  const thresholds = JSON.parse(
    readFileSync(
      join(
        here,
        "..",
        "skills",
        "is-this-backtest-lambo-or-lada",
        "thresholds.json",
      ),
      "utf8",
    ),
  );
  const importRoot = process.env.TRIAGE_TB_IMPORT_ROOT;

  const tb = mcpClient(url);
  await tb.connect();
  const cases = readdirSync(fixtures)
    .filter((d) => existsSync(join(fixtures, d, "triage.json")))
    .sort();
  for (const id of cases) {
    const manifest = JSON.parse(
      readFileSync(join(fixtures, id, "triage.json"), "utf8"),
    );
    if (importRoot) {
      await tb.call("import_csv", {
        csvPath: `${importRoot}/${id}/tradelog.csv`,
        blockName: manifest.block_id,
      });
    }
    const collected = await collectCase(tb, manifest, thresholds);
    const results = resultsFor(id, manifest, collected, tbVersion);
    writeFileSync(
      join(fixtures, id, "check-results.json"),
      JSON.stringify(results, null, 2) + "\n",
    );
    process.stdout.write(`${id}: written\n`);
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
