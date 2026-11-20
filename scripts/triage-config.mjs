#!/usr/bin/env node
// Local config of is-this-backtest-lambo-or-lada: where it lives, how its
// paths resolve, and the first-run setup.
//
// The config is one JSON file at a fixed default location
// ($XDG_CONFIG_HOME or ~/.config, then tradeblocks-skills/is-this-backtest-lambo-or-lada/local-config.json);
// TRIAGE_CONFIG only overrides that path. Relative paths inside the file
// resolve against the folder of the file (after following a symlink), and
// commands run in that folder, so the same file works wherever the folder is
// mounted.
//
//   node triage-config.mjs                      # resolve: JSON with absolute paths, or status "setup"
//   node triage-config.mjs setup --answers <answers.json>
//
// setup prints {status: "ask", ask: [{key, question, fixIn?}]} until every
// required answer is there, then writes the config (and a new cost file when
// asked to) and prints {status: "written", ...}. It never fills a cost value.
// Errors: "REASON: detail", exit 1.

import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const COST_FIELDS = [
  "entrySlippage",
  "exitSlippage",
  "stopLossSlippage",
  "openingFees",
  "closingFees",
];
export const SLIPPAGE_FIELDS = ["entrySlippage", "exitSlippage", "stopLossSlippage"];
const PLUGIN_ROLES = ["source", "runRequest"];
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

function checkPlugin(p) {
  if (p === undefined) return "not answered";
  if (!p || typeof p !== "object" || typeof p.exists !== "boolean")
    return 'give {"exists": false} or {"exists": true, ...}';
  if (!p.exists) return null;
  if (typeof p.name !== "string" || !p.name) return "name is required";
  if (
    !Array.isArray(p.roles) ||
    p.roles.length === 0 ||
    !p.roles.every((r) => PLUGIN_ROLES.includes(r))
  )
    return `roles is a non-empty list of ${PLUGIN_ROLES.join(", ")}`;
  if ((p.skill === undefined) === (p.command === undefined))
    return "give exactly one of skill (a skill name) or command (an argv array)";
  if (p.skill !== undefined && (typeof p.skill !== "string" || !p.skill))
    return "skill is a skill name";
  if (p.command !== undefined && !isArgv(p.command))
    return 'command is an argv array, e.g. ["node", "run-oo.mjs"]';
  return null;
}

/**
 * Read and check the local config; every path comes back absolute, every
 * command with the folder it runs in. `plugin` is null while not answered.
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
  const c = config.costs;
  if (!c || typeof c.base !== "string")
    fail("BAD_CONFIG", "costs.base (base scenario name) is required");
  if (!c.file === !c.command)
    fail("BAD_CONFIG", "give exactly one of costs.file or costs.command");
  if (c.command != null && !isArgv(c.command)) {
    fail("BAD_CONFIG", 'costs.command is an argv array, e.g. ["python3", "my_costs.py"]');
  }
  if (config.protocolHook != null && !isArgv(config.protocolHook))
    fail("BAD_CONFIG", "protocolHook is an argv array or null");
  const pluginProblem = config.plugin === undefined ? null : checkPlugin(config.plugin);
  if (pluginProblem) fail("BAD_CONFIG", `plugin: ${pluginProblem}`);
  const plugin = config.plugin ?? null;
  return {
    path: resolve(path),
    dir,
    costs: {
      file: c.file ? at(dir, c.file) : null,
      command: c.command ?? null,
      cwd: dir,
      base: c.base,
      cost2x: c.cost2x ?? null,
    },
    thresholds: at(dir, config.thresholds),
    verdictLog: at(dir, config.verdictLog),
    runRoot: at(dir, config.runRoot),
    protocolHook: config.protocolHook ? { command: config.protocolHook, cwd: dir } : null,
    plugin:
      plugin?.exists && plugin.command ? { ...plugin, cwd: dir } : plugin,
  };
}

function scenarioText(costs) {
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

/** Every problem of one scenario: [{field, problem}] (field null = scenario missing). */
function scenarioProblems(scenarios, name) {
  const s = scenarios?.[name];
  if (!s || typeof s !== "object") return [{ field: null, problem: "not found" }];
  return COST_FIELDS.filter((f) => !isCost(s[f])).map((f) => ({
    field: f,
    problem: "must be a number >= 0",
  }));
}

/**
 * Cost scenarios as Option Omega field values:
 * { "scenarios": { "<name>": { entrySlippage, exitSlippage, stopLossSlippage, openingFees, closingFees } } }.
 * From costs.file (that JSON) or from costs.command (prints that JSON; no
 * shell; runs in the config file's folder).
 */
export function loadScenarios(config) {
  const scenarios = parseScenarios(scenarioText(config.costs));
  const check = (name) => {
    const [p] = scenarioProblems(scenarios, name);
    if (p?.field === null) fail("BAD_COSTS", `scenario ${JSON.stringify(name)} not found`);
    if (p) fail("BAD_COSTS", `scenario ${name}: ${p.field} must be a number >= 0`);
    return Object.fromEntries(COST_FIELDS.map((f) => [f, scenarios[name][f]]));
  };
  const base = check(config.costs.base);
  const cost2x = config.costs.cost2x
    ? check(config.costs.cost2x)
    : {
        ...base,
        ...Object.fromEntries(SLIPPAGE_FIELDS.map((f) => [f, round(base[f] * 2)])),
      };
  return {
    base,
    cost2x,
    baseName: config.costs.base,
    cost2xName: config.costs.cost2x ?? `${config.costs.base} x2 slippage`,
  };
}

/** The config with absolute paths, or status "setup" with the reason. */
export function resolveConfig(env = process.env) {
  const loc = locateConfig(env);
  const head = { configPath: loc.path, configSource: loc.source };
  if (!loc.exists)
    return { status: "setup", ...head, reason: `no local config at ${loc.path}` };
  const c = readConfig(loc.path);
  if (c.plugin === null)
    return { status: "setup", ...head, reason: `plug-in not answered in ${loc.path}` };
  for (const k of ["verdictLog", "runRoot"]) {
    if (!c[k]) return { status: "setup", ...head, reason: `${k} missing in ${loc.path}` };
  }
  const { path, dir, ...rest } = c;
  return { status: "ready", ...head, ...rest };
}

// ---------------------------------------------------------------------------
// First-run setup
// ---------------------------------------------------------------------------

const FIELD_HELP = JSON.parse(readFileSync(join(templates, "costs.json"), "utf8")).fields;

const QUESTIONS = {
  "costs.source":
    'Where do the cost scenarios come from: an existing cost file in the format of templates/costs.json ({"source": "file", "file": <path>}), a command that prints that JSON from your own cost source ({"source": "command", "command": [argv]}), or a new cost file created now from the template ({"source": "new", "scenarios": {...}})?',
  "costs.file": "Path of your cost file (relative paths are relative to the config folder).",
  "costs.command": 'The command as an argv array, e.g. ["python3", "my_costs.py"]; it runs in the config folder.',
  base: "Name of the base cost scenario (every triage run is built on it).",
  plugin:
    'Is there a plug-in for source -> Option Omega and/or for running the run request? No: {"exists": false}. Yes: {"exists": true, "name": <name>, "roles": ["source", "runRequest"] (the ones it does), and "skill": <skill name> or "command": [argv]}.',
};

/** Store a path relative to the config folder when it lies inside it. */
function storedPath(p, dir) {
  if (p == null || !isAbsolute(p)) return p ?? null;
  const rel = relative(dir, p);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : p;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);

/**
 * First-run setup. `answers` holds what the user has said so far (keys as in
 * QUESTIONS; `cost2x`, `verdictLog`, `runRoot`, `thresholds`, `protocolHook`
 * optional). An existing config is the starting point; only what is missing
 * is asked.
 */
export function setup(answers, env = process.env) {
  const loc = locateConfig(env);
  const existing = loc.exists ? JSON.parse(readFileSync(loc.path, "utf8")) : null;
  const dir = loc.exists ? baseDir(loc.path) : dirname(loc.path);
  const ask = [];
  const need = (key, extra = {}) => ask.push({ key, question: QUESTIONS[key], ...extra });

  const base = answers.base ?? existing?.costs?.base;
  if (typeof base !== "string" || !base) need("base");
  const cost2x = answers.cost2x !== undefined ? answers.cost2x : (existing?.costs?.cost2x ?? null);
  const names = [base, cost2x].filter((n) => typeof n === "string" && n);

  let costs = null; // what goes into the config
  let newCostFile = null; // {path, scenarios} when the setup creates the cost file
  const zeroCostFields = [];
  const zeros = (scenarios) => {
    for (const [name, label] of [[base, "base"], [cost2x, "cost2x"]]) {
      if (!name) continue;
      for (const f of COST_FIELDS) if (scenarios[name]?.[f] === 0) zeroCostFields.push(`${label}.${f}`);
    }
  };
  const a = answers.costs;
  if (a === undefined && existing?.costs) {
    costs = {
      file: existing.costs.file ? resolve(dir, existing.costs.file) : null,
      command: existing.costs.command ?? null,
    };
  } else if (a === undefined) {
    need("costs.source");
  } else if (a.source === "new") {
    const path = resolve(dir, a.file ?? "costs.json");
    if (existsSync(path)) fail("EXISTS", `${path} exists; name it as {"source": "file"} or choose another path`);
    for (const name of names) {
      for (const f of COST_FIELDS) {
        if (!isCost(a.scenarios?.[name]?.[f])) {
          ask.push({
            key: `costs.scenarios.${name}.${f}`,
            question: `Scenario ${name}: ${FIELD_HELP[f]} (a number; 0 is allowed and is named in the summary).`,
          });
        }
      }
    }
    newCostFile = { path, scenarios: Object.fromEntries(names.map((n) => [n, a.scenarios?.[n]])) };
    if (names.length) zeros(a.scenarios ?? {});
    costs = { file: path, command: null };
  } else if (a.source === "file" || a.source === "command") {
    const file = a.source === "file" ? a.file : null;
    const command = a.source === "command" ? a.command : null;
    if (a.source === "file" && (typeof file !== "string" || !file)) need("costs.file");
    else if (a.source === "command" && !isArgv(command)) need("costs.command");
    else {
      costs = { file: file ? resolve(dir, file) : null, command };
    }
  } else {
    need("costs.source");
  }
  // An existing cost source is only read, never written: a gap is fixed there.
  if (costs && !newCostFile && names.length) {
    const where = costs.file ?? costs.command.join(" ");
    let scenarios;
    try {
      // Before the first write the config folder may not exist yet.
      const cwd = existsSync(dir) ? dir : process.cwd();
      scenarios = parseScenarios(scenarioText({ ...costs, cwd }));
    } catch (error) {
      ask.push({ key: costs.file ? "costs.file" : "costs.command", question: error.message, fixIn: where });
    }
    if (scenarios !== undefined) {
      for (const name of names) {
        for (const p of scenarioProblems(scenarios, name)) {
          ask.push({
            key: p.field ? `costs.scenarios.${name}.${p.field}` : `costs.scenarios.${name}`,
            question: p.field
              ? `Scenario ${name}: ${FIELD_HELP[p.field]} ${p.problem}; fix it in your cost source (the skill never writes it).`
              : `Scenario ${name} not found in your cost source.`,
            fixIn: where,
          });
        }
      }
      zeros(scenarios);
    }
  }

  const plugin = answers.plugin !== undefined ? answers.plugin : existing?.plugin;
  const pluginProblem = checkPlugin(plugin);
  if (pluginProblem) need("plugin", plugin === undefined ? {} : { problem: pluginProblem });

  if (ask.length) return { status: "ask", configPath: loc.path, ask };

  const defaults = [];
  const pick = (key, fallback) => {
    if (answers[key] !== undefined) return answers[key];
    if (existing && existing[key] !== undefined) return existing[key];
    if (fallback !== undefined) defaults.push(key);
    return fallback ?? null;
  };
  const config = {
    description:
      existing?.description ??
      "Local config of is-this-backtest-lambo-or-lada (first-run setup). Relative paths resolve against this file's folder; commands run there.",
    costs: {
      file: storedPath(costs.file, dir),
      command: costs.command,
      base,
      cost2x,
    },
    thresholds: pick("thresholds"),
    verdictLog: pick("verdictLog", "verdicts.jsonl"),
    runRoot: pick("runRoot", "runs"),
    protocolHook: pick("protocolHook"),
    plugin: plugin.exists ? plugin : { exists: false },
  };

  mkdirSync(dir, { recursive: true });
  let backup;
  if (loc.exists) {
    backup = `${loc.path}.bak-${stamp()}`;
    copyFileSync(loc.path, backup);
  }
  if (newCostFile) {
    const template = JSON.parse(readFileSync(join(templates, "costs.json"), "utf8"));
    writeFileSync(
      newCostFile.path,
      JSON.stringify(
        { description: template.description, fields: template.fields, scenarios: newCostFile.scenarios },
        null,
        2,
      ) + "\n",
    );
  }
  writeFileSync(loc.path, JSON.stringify(config, null, 2) + "\n");
  return {
    status: "written",
    configPath: loc.path,
    ...(backup ? { backup } : {}),
    ...(newCostFile ? { costFile: newCostFile.path } : {}),
    zeroCostFields,
    defaults,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main(argv, env = process.env) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "resolve")) return resolveConfig(env);
  if (argv[0] === "setup" && argv[1] === "--answers" && argv[2] && argv.length === 3) {
    return setup(JSON.parse(readFileSync(argv[2], "utf8")), env);
  }
  fail("USAGE", "triage-config.mjs [resolve] | setup --answers <answers.json>");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
