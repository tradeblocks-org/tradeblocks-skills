#!/usr/bin/env node
// Run request for is-this-backtest-lambo-or-lada (step 3).
//
// Reads the author run's Option Omega settings and the user's base cost
// scenario (through the local config) and writes the runs the triage still
// needs, each as exact field changes to the author run. The skill never runs
// Option Omega: a plug-in or the user builds these runs and adds them to the
// TradeBlocks block with the given labels.
//
//   TRIAGE_CONFIG=<local config> node triage-run-request.mjs \
//     --settings <author settings JSON> --author-label <label> [--manifest <triage.json>]
//
// <author settings JSON> is Option Omega's get_saved_backtest response (or its
// `parameters` object). Prints JSON on stdout; errors: "REASON: detail", exit 1.

import { readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const COST_FIELDS = [
  "entrySlippage",
  "exitSlippage",
  "stopLossSlippage",
  "openingFees",
  "closingFees",
];
const SLIPPAGE_FIELDS = ["entrySlippage", "exitSlippage", "stopLossSlippage"];
const MAX_RUNS = 4;

function fail(reason, detail) {
  throw new Error(`${reason}: ${detail}`);
}

// ---------------------------------------------------------------------------
// Local config and cost scenarios
// ---------------------------------------------------------------------------

/** Read and check the local config (one JSON file, path from TRIAGE_CONFIG). */
export function readConfig(path) {
  if (!path) fail("NO_CONFIG", "set TRIAGE_CONFIG to the local config file");
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail("BAD_CONFIG", `${path}: ${error.message}`);
  }
  const c = config.costs;
  if (!c || typeof c.base !== "string")
    fail("BAD_CONFIG", "costs.base (base scenario name) is required");
  if (!c.file === !c.command)
    fail("BAD_CONFIG", "give exactly one of costs.file or costs.command");
  if (
    c.command !== undefined &&
    (!Array.isArray(c.command) || c.command.length === 0)
  ) {
    fail(
      "BAD_CONFIG",
      'costs.command is an argv array, e.g. ["python3", "my_costs.py"]',
    );
  }
  return config;
}

/**
 * Cost scenarios as Option Omega field values:
 * { "scenarios": { "<name>": { entrySlippage, exitSlippage, stopLossSlippage, openingFees, closingFees } } }.
 * From costs.file (that JSON) or from costs.command (prints that JSON; no shell).
 */
export function loadScenarios(config) {
  let text;
  try {
    text = config.costs.file
      ? readFileSync(config.costs.file, "utf8")
      : execFileSync(config.costs.command[0], config.costs.command.slice(1), {
          encoding: "utf8",
        });
  } catch (error) {
    fail("BAD_COSTS", `cannot read the cost scenarios: ${error.message}`);
  }
  let scenarios;
  try {
    scenarios = JSON.parse(text).scenarios;
  } catch (error) {
    fail("BAD_COSTS", `cost scenarios are not JSON: ${error.message}`);
  }
  const check = (name) => {
    const s = scenarios?.[name];
    if (!s) fail("BAD_COSTS", `scenario ${JSON.stringify(name)} not found`);
    for (const f of COST_FIELDS) {
      if (typeof s[f] !== "number" || !Number.isFinite(s[f]) || s[f] < 0) {
        fail("BAD_COSTS", `scenario ${name}: ${f} must be a number >= 0`);
      }
    }
    return Object.fromEntries(COST_FIELDS.map((f) => [f, s[f]]));
  };
  const base = check(config.costs.base);
  const cost2x = config.costs.cost2x
    ? check(config.costs.cost2x)
    : {
        ...base,
        ...Object.fromEntries(
          SLIPPAGE_FIELDS.map((f) => [f, round(base[f] * 2)]),
        ),
      };
  return {
    base,
    cost2x,
    baseName: config.costs.base,
    cost2xName: config.costs.cost2x ?? `${config.costs.base} x2 slippage`,
  };
}

const round = (x) => Math.round(x * 1e6) / 1e6;

// ---------------------------------------------------------------------------
// Run request
// ---------------------------------------------------------------------------

const ENTRY_FILTER = /^entry(Min|Max|Vix(Min|Max)|Sma|IntradayEma)/;

/** Does Option Omega honour the author's intra-minute stops (SPX/SPY, every leg 0 DTE)? */
export function usesIntraMinuteStops(p) {
  const anyGroup = (p.exitConditions ?? []).some(
    (e) => e.useIntraMinuteStop === true,
  );
  const zeroDte =
    (p.legs ?? []).length > 0 && p.legs.every((l) => l.daysToExpiration === 0);
  return anyGroup && zeroDte && ["SPX", "SPY"].includes(p.underlying);
}

function costsOf(p) {
  return Object.fromEntries(COST_FIELDS.map((f) => [f, p[f] ?? 0]));
}

const sameCosts = (a, b) =>
  COST_FIELDS.every((f) => Math.abs(a[f] - b[f]) < 1e-9);

/** Field changes that turn the author run into its naive version. */
function naiveChanges(p) {
  const set = {};
  for (const [k, v] of Object.entries(p)) {
    if (ENTRY_FILTER.test(k) && v !== null && v !== undefined && v !== false)
      set[k] = null;
  }
  if (p.useOpeningRangeBreakout) set.useOpeningRangeBreakout = false;
  if ((p.reentryConditions ?? []).length > 0) set.reentryConditions = [];
  // Fixed size: one constant contract count per entry, no allocation-based sizing.
  set.maxContractsPerTrade = p.maxContractsPerTrade || 1;
  if (p.capitalPerContract) set.capitalPerContract = null;
  const exitConditions = (p.exitConditions ?? []).map(() => ({
    maxProfit: null,
    maxLoss: null,
    isTrailingStopLoss: false,
    useProfitActions: false,
    profitActions: [],
    useTimeActions: false,
    timeActions: [],
    exitAtDte: null,
    exitAtDit: null,
    exitAtMit: null,
    exitTime: null,
    exitWhenPutTested: false,
    exitWhenCallTested: false,
    useIntraMinuteStop: false,
  }));
  return { set, exitConditions };
}

/**
 * The runs the triage still needs. `have` lists roles the manifest already
 * has. Returns the flags the manifest must carry and at most four runs.
 */
export function runRequest(settings, scenarios, authorLabel, have = []) {
  const p = settings.parameters ?? settings;
  if (!p || !Array.isArray(p.legs))
    fail(
      "BAD_SETTINGS",
      "need Option Omega settings with legs and exitConditions",
    );
  const authorCosts = costsOf(p);
  const flags = {
    author_costs_match_base: sameCosts(authorCosts, scenarios.base),
    author_uses_intra_minute_stops: usesIntraMinuteStops(p),
  };
  const runs = [];
  const want = (role) => !have.includes(role);
  // Every run a check reads starts from the author's rules at the base costs.
  const base = { ...scenarios.base };

  if (!flags.author_costs_match_base && want("author_base")) {
    runs.push({
      role: "author_base",
      label: `${authorLabel} base-costs`,
      from: "author",
      set: base,
      why: `author costs ${JSON.stringify(authorCosts)} differ from the base scenario ${scenarios.baseName}; replaces the author run in every check`,
    });
  }
  if (want("naive")) {
    const n = naiveChanges(p);
    runs.push({
      role: "naive",
      label: `${authorLabel} naive`,
      from: "author",
      set: { ...base, ...n.set },
      exitConditions: n.exitConditions,
      why: "author run minus every optional lever (profit target, stops, time and tested exits, entry filters, re-entry, sizing), held to expiry, at base costs",
    });
  }
  if (want("cost_2x")) {
    runs.push({
      role: "cost_2x",
      label: `${authorLabel} slip2x`,
      from: "author",
      set: { ...scenarios.cost2x },
      why: `author rules at ${scenarios.cost2xName}`,
    });
  }
  if (flags.author_uses_intra_minute_stops && want("minute_stop")) {
    runs.push({
      role: "minute_stop",
      label: `${authorLabel} minute-stop`,
      from: "author",
      set: base,
      exitConditions: (p.exitConditions ?? []).map(() => ({
        useIntraMinuteStop: false,
      })),
      why: "author rules at base costs with one-minute instead of intra-minute stops",
    });
  }
  if (runs.length > MAX_RUNS)
    fail("TOO_MANY_RUNS", `${runs.length} runs requested`);
  return { flags, baseScenario: scenarios.baseName, runs };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) {
      fail(
        "USAGE",
        "triage-run-request.mjs --settings <file> --author-label <label> [--manifest <file>]",
      );
    }
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

export function main(argv, env = process.env) {
  const a = args(argv);
  if (!a.settings || !a["author-label"])
    fail("USAGE", "--settings and --author-label are required");
  const config = readConfig(env.TRIAGE_CONFIG);
  const scenarios = loadScenarios(config);
  const settings = JSON.parse(readFileSync(a.settings, "utf8"));
  const have = a.manifest
    ? Object.keys(JSON.parse(readFileSync(a.manifest, "utf8")).runs ?? {})
    : [];
  return runRequest(settings, scenarios, a["author-label"], have);
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
