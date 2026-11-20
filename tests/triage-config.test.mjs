import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  defaultConfigPath,
  locateConfig,
  readConfig,
  resolveConfig,
  setup,
} from "../scripts/triage-config.mjs";
import { loadScenarios, main } from "../scripts/triage-run-request.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "scripts", "triage-config.mjs");

// Synthetic values only.
const BASE = {
  entrySlippage: 0.3,
  exitSlippage: 0.1,
  stopLossSlippage: 0.6,
  openingFees: 2,
  closingFees: 2,
};
const SETTINGS = {
  parameters: {
    underlying: "SPX",
    legs: [{ type: "Put", buySell: "Sell", daysToExpiration: 0 }],
    exitConditions: [{ useIntraMinuteStop: false }],
    ...BASE,
    rangeStart: "2024-01-02",
    rangeEnd: "2024-06-28",
  },
};

const tmp = () => mkdtempSync(join(tmpdir(), "tc-"));
const write = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
  return p;
};
const keys = (r) => r.ask.map((a) => a.key);

// --- location -------------------------------------------------------------

test("default location under the user's config home; TRIAGE_CONFIG only overrides", () => {
  const home = tmp();
  assert.equal(
    defaultConfigPath({ HOME: home }),
    join(home, ".config", "tradeblocks-skills", "is-this-backtest-lambo-or-lada", "local-config.json"),
  );
  assert.equal(
    defaultConfigPath({ HOME: home, XDG_CONFIG_HOME: "/x/cfg" }),
    "/x/cfg/tradeblocks-skills/is-this-backtest-lambo-or-lada/local-config.json",
  );
  assert.deepEqual(locateConfig({ HOME: home }), {
    path: defaultConfigPath({ HOME: home }),
    source: "default",
    exists: false,
  });
  const other = write(join(home, "elsewhere.json"), {});
  assert.deepEqual(locateConfig({ HOME: home, TRIAGE_CONFIG: other }), {
    path: other,
    source: "TRIAGE_CONFIG",
    exists: true,
  });
  // A relative override is taken from the working directory, like any CLI path.
  assert.equal(
    locateConfig({ HOME: home, TRIAGE_CONFIG: "rel.json" }).path,
    join(process.cwd(), "rel.json"),
  );
});

// --- relative paths ---------------------------------------------------------

test("paths inside the config resolve relative to the config file; absolute paths still work", () => {
  const dir = tmp();
  write(join(dir, "data", "costs.json"), { scenarios: { b: BASE } });
  const cfg = write(join(dir, "cfg", "local-config.json"), {
    costs: { file: "../data/costs.json", base: "b" },
    thresholds: "my-thresholds.json",
    verdictLog: "../data/verdicts.jsonl",
    runRoot: "/abs/runs",
    protocolHook: ["python3", "hook.py"],
    plugin: { exists: false },
  });
  const c = readConfig(cfg);
  assert.equal(c.costs.file, join(dir, "data", "costs.json"));
  assert.equal(c.thresholds, join(dir, "cfg", "my-thresholds.json"));
  assert.equal(c.verdictLog, join(dir, "data", "verdicts.jsonl"));
  assert.equal(c.runRoot, "/abs/runs");
  assert.deepEqual(c.protocolHook, { command: ["python3", "hook.py"], cwd: join(dir, "cfg") });
  assert.deepEqual(loadScenarios(c).base, BASE);
});

test("a cost command runs in the config file's folder (relative script argument)", () => {
  const dir = tmp();
  write(
    join(dir, "costs.mjs"),
    `process.stdout.write(JSON.stringify({ scenarios: { b: ${JSON.stringify(BASE)} } }));`,
  );
  const cfg = write(join(dir, "local-config.json"), {
    costs: { command: [process.execPath, "costs.mjs"], base: "b" },
    plugin: { exists: false },
  });
  const c = readConfig(cfg);
  assert.equal(c.costs.cwd, dir);
  // Called from another working directory, the relative script is still found.
  const prev = process.cwd();
  process.chdir(tmp());
  try {
    assert.deepEqual(loadScenarios(c).base, BASE);
  } finally {
    process.chdir(prev);
  }
});

test("a symlinked config resolves relative to the file it points to", () => {
  const dir = tmp();
  write(join(dir, "real", "costs.json"), { scenarios: { b: BASE } });
  const realCfg = write(join(dir, "real", "local-config.json"), {
    costs: { file: "costs.json", base: "b" },
    verdictLog: "verdicts.jsonl",
    plugin: { exists: false },
  });
  const link = join(dir, "home", ".config", "x", "local-config.json");
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(realCfg, link);
  const c = readConfig(link);
  assert.equal(c.verdictLog, join(dir, "real", "verdicts.jsonl"));
  assert.deepEqual(loadScenarios(c).base, BASE);
});

// --- first-run setup --------------------------------------------------------

test("no config: resolve reports setup, never a default config", () => {
  const home = tmp();
  const r = resolveConfig({ HOME: home });
  assert.equal(r.status, "setup");
  assert.equal(r.configPath, defaultConfigPath({ HOME: home }));
  assert.match(r.reason, /no local config/);
  assert.equal(existsSync(r.configPath), false);
});

test("no config: run request stops with SETUP_NEEDED naming the path, not NO_CONFIG on a missing variable", () => {
  const home = tmp();
  const s = write(join(home, "settings.json"), SETTINGS);
  assert.throws(
    () => main(["--settings", s, "--author-label", "X"], { HOME: home }),
    (e) =>
      /^SETUP_NEEDED: no local config at /.test(e.message) &&
      e.message.includes(defaultConfigPath({ HOME: home })),
  );
});

test("setup with no answers asks where the costs come from, the base scenario and the plug-in", () => {
  const home = tmp();
  const r = setup({}, { HOME: home });
  assert.equal(r.status, "ask");
  assert.deepEqual(keys(r).sort(), ["base", "costs.source", "plugin"]);
  assert.equal(existsSync(defaultConfigPath({ HOME: home })), false);
});

test("setup with a new cost file asks every required field not supplied; never 0 or a default", () => {
  const home = tmp();
  const partial = {
    costs: { source: "new", scenarios: { b: { entrySlippage: 0.3, exitSlippage: "", openingFees: null } } },
    base: "b",
    plugin: { exists: false },
  };
  const r = setup(partial, { HOME: home });
  assert.equal(r.status, "ask");
  assert.deepEqual(keys(r).sort(), [
    "costs.scenarios.b.closingFees",
    "costs.scenarios.b.exitSlippage",
    "costs.scenarios.b.openingFees",
    "costs.scenarios.b.stopLossSlippage",
  ]);
  for (const a of r.ask) assert.match(a.question, /\S/);
  assert.equal(existsSync(defaultConfigPath({ HOME: home })), false);
});

test("setup accepts an explicit 0 and names it; writes the cost file and the config with relative paths", () => {
  const home = tmp();
  const r = setup(
    {
      costs: { source: "new", scenarios: { b: { ...BASE, exitSlippage: 0 } } },
      base: "b",
      plugin: { exists: false },
    },
    { HOME: home },
  );
  assert.equal(r.status, "written", JSON.stringify(r));
  assert.deepEqual(r.zeroCostFields, ["base.exitSlippage"]);
  const cfgPath = defaultConfigPath({ HOME: home });
  const raw = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(raw.costs.file, "costs.json");
  assert.equal(raw.verdictLog, "verdicts.jsonl");
  assert.equal(raw.runRoot, "runs");
  assert.deepEqual(raw.plugin, { exists: false });
  // The cost values live in the cost file only, never in the config.
  assert.equal(JSON.stringify(raw).includes("stopLossSlippage"), false);
  const costs = JSON.parse(readFileSync(join(dirname(cfgPath), "costs.json"), "utf8"));
  assert.equal(costs.scenarios.b.exitSlippage, 0);
  assert.equal(resolveConfig({ HOME: home }).status, "ready");
});

test("setup on an existing cost source: a missing field is asked to be fixed in that source, nothing written", () => {
  const home = tmp();
  const own = write(join(home, "own-costs.json"), { scenarios: { b: { ...BASE, closingFees: "<number>" } } });
  const r = setup(
    { costs: { source: "file", file: own }, base: "b", plugin: { exists: false } },
    { HOME: home },
  );
  assert.equal(r.status, "ask");
  assert.deepEqual(keys(r), ["costs.scenarios.b.closingFees"]);
  assert.equal(r.ask[0].fixIn, own);
  assert.equal(existsSync(defaultConfigPath({ HOME: home })), false);
  // The user's own file is never written by the skill.
  assert.equal(JSON.parse(readFileSync(own, "utf8")).scenarios.b.closingFees, "<number>");
});

test("setup with a cost command: the command is stored, values stay in the user's source", () => {
  const home = tmp();
  const cmd = write(
    join(home, "src", "print-costs.mjs"),
    `process.stdout.write(JSON.stringify({ scenarios: { b: ${JSON.stringify(BASE)} } }));`,
  );
  const r = setup(
    { costs: { source: "command", command: [process.execPath, cmd] }, base: "b", plugin: { exists: false } },
    { HOME: home },
  );
  assert.equal(r.status, "written", JSON.stringify(r));
  const raw = JSON.parse(readFileSync(defaultConfigPath({ HOME: home }), "utf8"));
  assert.deepEqual(raw.costs.command, [process.execPath, cmd]);
  assert.equal(raw.costs.file, null);
});

test("plug-in yes: name, roles and how to call it are stored; the run request hands it over", () => {
  const home = tmp();
  const plugin = { exists: true, name: "my-oo-runner", roles: ["source", "runRequest"], skill: "my-oo-runner" };
  const incomplete = setup(
    { costs: { source: "new", scenarios: { b: BASE } }, base: "b", plugin: { exists: true } },
    { HOME: home },
  );
  assert.deepEqual(keys(incomplete), ["plugin"]);
  const r = setup({ costs: { source: "new", scenarios: { b: BASE } }, base: "b", plugin }, { HOME: home });
  assert.equal(r.status, "written", JSON.stringify(r));
  const s = write(join(home, "settings.json"), SETTINGS);
  const out = main(["--settings", s, "--author-label", "X"], { HOME: home });
  assert.deepEqual(out.execution, { by: "plugin", plugin: "my-oo-runner", call: { skill: "my-oo-runner" } });
});

test("plug-in no: the answer is stored and the run request says to build the runs in the OO web UI", () => {
  const home = tmp();
  setup({ costs: { source: "new", scenarios: { b: BASE } }, base: "b", plugin: { exists: false } }, { HOME: home });
  const s = write(join(home, "settings.json"), SETTINGS);
  const out = main(["--settings", s, "--author-label", "X"], { HOME: home });
  assert.equal(out.execution.by, "user");
  assert.match(out.execution.how, /Option Omega web UI/);
});

test("a plug-in that only does source -> OO leaves the runs to the user", () => {
  const home = tmp();
  setup(
    {
      costs: { source: "new", scenarios: { b: BASE } },
      base: "b",
      plugin: { exists: true, name: "yt2oo", roles: ["source"], command: ["yt2oo"] },
    },
    { HOME: home },
  );
  const s = write(join(home, "settings.json"), SETTINGS);
  assert.equal(main(["--settings", s, "--author-label", "X"], { HOME: home }).execution.by, "user");
});

test("an existing config without a plug-in answer asks only for it and keeps everything else", () => {
  const home = tmp();
  write(join(home, "cfg", "costs.json"), { scenarios: { b: BASE } });
  const cfg = write(join(home, "cfg", "local-config.json"), {
    costs: { file: "costs.json", command: null, base: "b", cost2x: null },
    thresholds: null,
    verdictLog: "v.jsonl",
    runRoot: "r",
    protocolHook: null,
  });
  const env = { HOME: home, TRIAGE_CONFIG: cfg };
  assert.equal(resolveConfig(env).status, "setup");
  const s = write(join(home, "settings.json"), SETTINGS);
  assert.throws(() => main(["--settings", s, "--author-label", "X"], env), /^Error: SETUP_NEEDED: plug-in/);
  assert.deepEqual(keys(setup({}, env)), ["plugin"]);
  const r = setup({ plugin: { exists: false } }, env);
  assert.equal(r.status, "written");
  assert.ok(existsSync(r.backup), "existing config backed up before the write");
  const raw = JSON.parse(readFileSync(cfg, "utf8"));
  assert.equal(raw.verdictLog, "v.jsonl");
  assert.equal(raw.costs.file, "costs.json");
  assert.deepEqual(raw.plugin, { exists: false });
});

test("setup never overwrites an existing cost file", () => {
  const home = tmp();
  const cfgDir = dirname(defaultConfigPath({ HOME: home }));
  write(join(cfgDir, "costs.json"), { scenarios: {} });
  assert.throws(
    () => setup({ costs: { source: "new", scenarios: { b: BASE } }, base: "b", plugin: { exists: false } }, { HOME: home }),
    /^Error: EXISTS: /,
  );
});

test("CLI: resolve prints absolute paths; setup reads answers from a file", () => {
  const home = tmp();
  const env = { ...process.env, HOME: home, TRIAGE_CONFIG: "" };
  delete env.XDG_CONFIG_HOME;
  const first = spawnSync(process.execPath, [script], { encoding: "utf8", env });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, "setup");
  const answers = write(join(home, "answers.json"), {
    costs: { source: "new", scenarios: { b: BASE } },
    base: "b",
    plugin: { exists: false },
  });
  const w = spawnSync(process.execPath, [script, "setup", "--answers", answers], { encoding: "utf8", env });
  assert.equal(w.status, 0, w.stderr);
  assert.equal(JSON.parse(w.stdout).status, "written");
  const r = JSON.parse(spawnSync(process.execPath, [script], { encoding: "utf8", env }).stdout);
  assert.equal(r.status, "ready");
  const dir = dirname(defaultConfigPath({ HOME: home }));
  assert.equal(r.verdictLog, join(dir, "verdicts.jsonl"));
  assert.equal(r.runRoot, join(dir, "runs"));
  assert.equal(r.costs.file, join(dir, "costs.json"));
});

test("setup through a symlinked config writes the real file and backs it up next to it", () => {
  const dir = tmp();
  write(join(dir, "real", "costs.json"), { scenarios: { b: BASE } });
  const realCfg = write(join(dir, "real", "local-config.json"), {
    costs: { file: "costs.json", base: "b" },
    verdictLog: "v.jsonl",
    runRoot: "r",
  });
  const link = join(dir, "home", ".config", "x", "local-config.json");
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(realCfg, link);
  const r = setup({ plugin: { exists: false } }, { HOME: dir, TRIAGE_CONFIG: link });
  assert.equal(r.status, "written");
  assert.equal(dirname(r.backup), join(dir, "real"));
  assert.deepEqual(JSON.parse(readFileSync(realCfg, "utf8")).plugin, { exists: false });
  assert.equal(realpathSync(link), realCfg, "the symlink stays a symlink");
});
