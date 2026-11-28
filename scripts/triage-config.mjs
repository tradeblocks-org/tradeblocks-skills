#!/usr/bin/env node
// Local config of is-this-backtest-lambo-or-lada: where it lives, how its
// paths resolve, and the check that names every gap in it.
//
// The config is one JSON file at a fixed default location
// ($XDG_CONFIG_HOME or ~/.config, then tradeblocks-skills/is-this-backtest-lambo-or-lada/local-config.json);
// TRIAGE_CONFIG only overrides that path. Relative paths inside the file
// resolve against the folder of the file (after following a symlink), and
// commands run in that folder, so the same file works wherever the folder is
// mounted. There is no setup dialogue: copy templates/local-config.json to
// that path and fill it in; this script names what is still missing.
//
//   node triage-config.mjs      # {status: "ready", ...absolute paths} or {status: "setup", template, reason}
//
// It never fills a cost value. Errors: "REASON: detail", exit 1.

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COST_FIELDS = [
  "entrySlippage",
  "exitSlippage",
  "stopLossSlippage",
  "openingFees",
  "closingFees",
];
export const SLIPPAGE_FIELDS = ["entrySlippage", "exitSlippage", "stopLossSlippage"];
const templates = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "is-this-backtest-lambo-or-lada",
  "templates",
);

function fail(reason, detail) {
  throw new Error(`${reason}: ${detail}`);
}

const round = (x) => Math.round(x * 1e6) / 1e6;
const isCost = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isArgv = (v) =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x !== "");

// ---------------------------------------------------------------------------
// Location and reading
// ---------------------------------------------------------------------------

/** The fixed default location (documented in SKILL.md). */
export function defaultConfigPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME ?? "", ".config");
  return join(base, "tradeblocks-skills", "is-this-backtest-lambo-or-lada", "local-config.json");
}

/** TRIAGE_CONFIG when set (relative to the working directory), else the default. */
export function locateConfig(env = process.env) {
  const path = env.TRIAGE_CONFIG ? resolve(env.TRIAGE_CONFIG) : defaultConfigPath(env);
  return {
    path,
    source: env.TRIAGE_CONFIG ? "TRIAGE_CONFIG" : "default",
    exists: existsSync(path),
  };
}

// The folder relative paths resolve against: the real file's, so a symlinked
// config behaves like the file it points to.
const baseDir = (path) => dirname(realpathSync(path));
const at = (dir, p) => (p == null ? null : resolve(dir, p));

/**
 * Read and check the local config; every path comes back absolute, every
 * command with the folder it runs in.
 */
export function readConfig(path) {
  if (!path) fail("NO_CONFIG", "no local config path given");
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail("BAD_CONFIG", `${path}: ${error.message}`);
  }
  const dir = baseDir(path);
  const c = config.costs ?? {};
  const problems = [];
  if (typeof c.base !== "string" || c.base === "") problems.push("costs.base (base scenario name) is required");
  if ([c.file, c.command, c.example].filter(Boolean).length !== 1)
    problems.push("give exactly one of costs.file, costs.command or costs.example");
  if (c.example) {
    if (typeof c.example.confirmedAt !== "string" || c.example.confirmedAt === "")
      problems.push("costs.example needs confirmedAt: the time the user confirmed the example values");
    if (c.base !== EXAMPLE_NAME) problems.push(`costs.base must be "${EXAMPLE_NAME}" with costs.example`);
  }
  if (c.command != null && !isArgv(c.command))
    problems.push('costs.command is an argv array, e.g. ["python3", "my_costs.py"]');
  for (const k of ["verdictLog", "runRoot"])
    if (typeof config[k] !== "string" || config[k] === "") problems.push(`${k} (a path) is required`);
  if (problems.length) fail("BAD_CONFIG", problems.join("; "));
  return {
    path: resolve(path),
    dir,
    costs: {
      file: c.file ? at(dir, c.file) : null,
      command: c.command ?? null,
      example: c.example ? { ...c.example } : null,
      cwd: dir,
      base: c.base,
    },
    verdictLog: at(dir, config.verdictLog),
    runRoot: at(dir, config.runRoot),
  };
}

function scenarioText(costs) {
  // The template's placeholder path is unchanged: say what to do, not ENOENT.
  if (/<[^<>]*>$/.test(costs.file ?? ""))
    fail("COSTS_NOT_FILLED", "costs not filled in: give a cost file or command, or confirm the example scenario");
  try {
    return costs.file
      ? readFileSync(costs.file, "utf8")
      : execFileSync(costs.command[0], costs.command.slice(1), {
          encoding: "utf8",
          cwd: costs.cwd,
        });
  } catch (error) {
    fail("BAD_COSTS", `cannot read the cost scenarios: ${error.message}`);
  }
}

function parseScenarios(text) {
  try {
    return JSON.parse(text).scenarios;
  } catch (error) {
    fail("BAD_COSTS", `cost scenarios are not JSON: ${error.message}`);
  }
}

/**
 * Cost scenarios as Option Omega field values:
 * { "scenarios": { "<name>": { entrySlippage, exitSlippage, stopLossSlippage, openingFees, closingFees } } }.
 * From costs.file (that JSON) or from costs.command (prints that JSON; no
 * shell; runs in the config file's folder).
 */
export function loadScenarios(config) {
  const example = !!config.costs.example;
  let scenarios;
  if (example) {
    scenarios = readExample().scenarios;
  } else {
    scenarios = parseScenarios(scenarioText(config.costs));
  }
  const check = (name) => {
    const s = scenarios?.[name];
    if (!s || typeof s !== "object") fail("BAD_COSTS", `scenario ${JSON.stringify(name)} not found`);
    const bad = COST_FIELDS.filter((f) => !isCost(s[f]));
    if (bad.length) fail("BAD_COSTS", `scenario ${name}: ${bad.join(", ")} must be numbers >= 0`);
    return Object.fromEntries(COST_FIELDS.map((f) => [f, scenarios[name][f]]));
  };
  const base = check(config.costs.base);
  const cost2x = cost2xOf(base);
  return {
    base,
    cost2x,
    baseName: config.costs.base,
    cost2xName: `${config.costs.base} x2 slippage`,
    example,
  };
}

/** cost_2x: base slippage x 2, base fees; never a scenario of its own. */
export function cost2xOf(base) {
  return {
    ...base,
    ...Object.fromEntries(SLIPPAGE_FIELDS.map((f) => [f, round(base[f] * 2)])),
  };
}

// ---------------------------------------------------------------------------
// Example costs (shipped, labelled; used only after explicit confirmation)
// ---------------------------------------------------------------------------

export const EXAMPLE_NAME = "example";
export const EXAMPLE_PATH = join(templates, "costs-example.json");

export const readExample = () => JSON.parse(readFileSync(EXAMPLE_PATH, "utf8"));

export const TEMPLATE_PATH = join(templates, "local-config.json");

/**
 * The config with absolute paths (its cost scenarios read and checked), or
 * status "setup" with the template and every problem found.
 */
export function resolveConfig(env = process.env) {
  const loc = locateConfig(env);
  const head = { configPath: loc.path, configSource: loc.source, template: TEMPLATE_PATH };
  if (!loc.exists)
    return { status: "setup", ...head, reason: `no local config at ${loc.path}: copy the template there and fill it in` };
  let c;
  try {
    c = readConfig(loc.path);
    loadScenarios(c);
  } catch (error) {
    return { status: "setup", ...head, reason: error.message };
  }
  const { path, dir, ...rest } = c;
  // Overriding is allowed, but a second config that is another file is named, so the two cannot drift unseen.
  const def = defaultConfigPath(env);
  const note = loc.source === "TRIAGE_CONFIG" && existsSync(def) && realpathSync(def) !== realpathSync(loc.path)
    ? `TRIAGE_CONFIG ${loc.path} overrides the config at ${def} (another file); the scripts use TRIAGE_CONFIG` : undefined;
  return { status: "ready", configPath: loc.path, configSource: loc.source, ...(note ? { note } : {}), ...rest };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main(argv, env = process.env) {
  if (argv.length > 0) fail("USAGE", "triage-config.mjs (no arguments)");
  return resolveConfig(env);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
