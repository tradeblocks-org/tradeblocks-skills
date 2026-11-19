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

import { readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
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
    const res = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(body) });
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
    if (!json) throw new Error(`MCP_REPLY: empty reply to ${method} (HTTP ${res.status})`);
    const msg = JSON.parse(json);
    if (msg.error) throw new Error(`MCP_ERROR: ${method}: ${JSON.stringify(msg.error)}`);
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
      if (r.isError) throw new Error(`TOOL_ERROR: ${name}: ${r.content?.[0]?.text}`);
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

const WEEKDAYS = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5 };

export async function collectCase(tb, manifest, thresholds) {
  const block = manifest.block_id;
  const { author, naive, cost_2x: cost2x } = manifest.runs;
  const stats = (strategy, extra = {}) =>
    tb.call("get_statistics", { blockId: block, strategy, riskFreeRateAnnualPct: 0, ...extra });
  const checks = {};

  // C2
  const authorStats = await stats(author, { topDays: [1, 5, 10] });
  const monthly = await tb.call("get_period_returns", { blockId: block, strategy: author, period: "monthly" });
  const months = monthsCovered(monthly.periods);
  checks.C2 = { metrics: { trades: authorStats.stats.totalTrades, months } };

  // C3: DTE from the author run; missing rule days from the naive run when
  // the author uses entry filters (no naive run -> that part not run).
  const oo = manifest.oo_settings;
  const rule = {
    entryWeekdays: oo.entryDays.map((d) => WEEKDAYS[d]),
    dte: oo.dte,
    selection: oo.useExactDte ? "exact" : "firstAtLeast",
  };
  const rcAuthor = await tb.call("get_rule_calendar", { blockId: block, strategy: author, rule });
  const filtered = (oo.entryFilters ?? []).length > 0;
  let missingRuleDayShare = rcAuthor.missingRuleDays.share;
  let notRunReason;
  if (filtered) {
    if (naive) {
      missingRuleDayShare = (await tb.call("get_rule_calendar", { blockId: block, strategy: naive, rule }))
        .missingRuleDays.share;
    } else {
      missingRuleDayShare = null;
      notRunReason = "missing rule days need the naive run (author uses entry filters)";
    }
  }
  checks.C3 = {
    metrics: { maxYearDteMismatchShare: rcAuthor.dte.maxYearMismatchShare, missingRuleDayShare },
    ...(notRunReason ? { notRunReason } : {}),
  };

  // C4
  if (naive) {
    const pb = await tb.call("paired_bootstrap_comparison", {
      blockId: block,
      strategyA: author,
      strategyB: naive,
      unobservedDays: "zero",
      grid: "xnys",
      seed: thresholds.bootstrap.seed,
      resamples: thresholds.bootstrap.resamples,
      ciLevel: thresholds.bootstrap.ciLevel,
    });
    checks.C4 = { metrics: { point: pb.point, ciLow: pb.ci.low, ciHigh: pb.ci.high } };
  }

  // C5
  const pwb = Object.fromEntries(authorStats.plWithoutBestDays.map((r) => [r.n, r]));
  checks.C5 = {
    metrics: {
      plWithoutBest5: pwb[5].pl,
      best10Share: pwb[10].shareOfTotal ?? 1,
      positiveYearShare: authorStats.positiveYearShare,
    },
  };

  // C6: TradeBlocks' own stress windows, author P&L per window.
  const st = await tb.call("stress_test", { blockId: block });
  const windows = st.scenarios.filter((s) => !s.isCustom && !s.name.endsWith("_recovery"));
  let worst = 0;
  for (const w of windows) {
    const s = await stats(author, { startDate: w.dateRange.start, endDate: w.dateRange.end }).catch(() => null);
    worst = Math.min(worst, s?.stats?.netPl ?? 0);
  }
  const avgMonth = authorStats.stats.netPl / months;
  checks.C6 = {
    metrics: {
      stressPeriodsInRecord: windows.length,
      worstStressLossInAvgMonths: worst >= 0 ? 0 : avgMonth > 0 ? -worst / avgMonth : 99,
    },
  };

  // C7
  if (cost2x) {
    const c = (await stats(cost2x)).stats.netPl;
    const base = authorStats.stats.netPl;
    checks.C7 = { metrics: { cost2xPl: c, cost2xKeepShare: base > 0 ? c / base : 0 } };
  }

  // C8
  if (manifest.runs.minute_stop) {
    const m = (await stats(manifest.runs.minute_stop)).stats.netPl;
    const base = authorStats.stats.netPl;
    checks.C8 = { metrics: { minuteStopPl: m, minuteStopDropShare: base > 0 ? 1 - m / base : 1 } };
  }

  return checks;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  const url = process.env.TRIAGE_TB_URL;
  if (!url) throw new Error("USAGE: set TRIAGE_TB_URL to the TradeBlocks MCP endpoint");
  const versionAt = argv.indexOf("--tb-version");
  const tbVersion = versionAt >= 0 ? argv[versionAt + 1] : "unknown";
  const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--tb-version");
  const fixtures = positional[0] ?? join(here, "..", "tests", "fixtures", "triage");
  const thresholds = JSON.parse(
    readFileSync(join(here, "..", "skills", "is-this-backtest-lambo-or-lada", "thresholds.json"), "utf8"),
  );
  const importRoot = process.env.TRIAGE_TB_IMPORT_ROOT;

  const tb = mcpClient(url);
  await tb.connect();
  const cases = readdirSync(fixtures).filter((d) => existsSync(join(fixtures, d, "triage.json"))).sort();
  for (const id of cases) {
    const manifest = JSON.parse(readFileSync(join(fixtures, id, "triage.json"), "utf8"));
    if (importRoot) {
      await tb.call("import_csv", {
        csvPath: `${importRoot}/${id}/tradelog.csv`,
        blockName: manifest.block_id,
      });
    }
    const checks = await collectCase(tb, manifest, thresholds);
    const results = {
      _source:
        `Frozen check results: the synthetic trade log of this case imported into TradeBlocks ${tbVersion} ` +
        "and read with the TradeBlocks calls in SKILL.md (scripts/triage-collect.mjs).",
      case: id,
      runAt: "2026-11-19T00:00:00Z",
      source: manifest.source ? { ref: manifest.source.ref } : null,
      ruleSheet: manifest.source?.rule_sheet ?? null,
      runs: manifest.runs,
      variantsTried: manifest.variants_tried,
      authorUsesIntraMinuteStops: false,
      checks,
      versions: { tradeblocks: tbVersion },
      ooRunIds: [],
      runFolder: null,
    };
    writeFileSync(join(fixtures, id, "check-results.json"), JSON.stringify(results, null, 2) + "\n");
    process.stdout.write(`${id}: written\n`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
