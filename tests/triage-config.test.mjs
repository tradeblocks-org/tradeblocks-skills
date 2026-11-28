import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  COST_FIELDS,
  TEMPLATE_PATH,
  EXAMPLE_PATH,
  defaultConfigPath,
  locateConfig,
  readConfig,
  loadScenarios,
  resolveConfig,
} from "../scripts/triage-config.mjs";

// One temp folder per test file, removed after the file's tests.
const ROOT = mkdtempSync(join(tmpdir(), "tc-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "scripts", "triage-config.mjs");

// Synthetic values only.
const BASE = { entrySlippage: 0.3, exitSlippage: 0.1, stopLossSlippage: 0.6, openingFees: 2, closingFees: 2 };
const tmp = () => mkdtempSync(join(ROOT, "tc-"));
const write = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
  return p;
};
const config = (costs, extra = {}) => ({ costs, verdictLog: "verdicts.jsonl", runRoot: "runs", ...extra });

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
  assert.deepEqual(locateConfig({ HOME: home }), { path: defaultConfigPath({ HOME: home }), source: "default", exists: false });
  const other = write(join(home, "elsewhere.json"), {});
  assert.deepEqual(locateConfig({ HOME: home, TRIAGE_CONFIG: other }), { path: other, source: "TRIAGE_CONFIG", exists: true });
  // A relative override is taken from the working directory, like any CLI path.
  assert.equal(locateConfig({ HOME: home, TRIAGE_CONFIG: "rel.json" }).path, join(process.cwd(), "rel.json"));
});

// --- relative paths ---------------------------------------------------------

test("paths inside the config resolve relative to the config file; absolute paths still work", () => {
  const dir = tmp();
  write(join(dir, "data", "costs.json"), { scenarios: { b: BASE } });
  const cfg = write(join(dir, "cfg", "local-config.json"), {
    costs: { file: "../data/costs.json", base: "b" },
    verdictLog: "../data/verdicts.jsonl",
    runRoot: "/abs/runs",
  });
  const c = readConfig(cfg);
  assert.equal(c.costs.file, join(dir, "data", "costs.json"));
  assert.equal(c.verdictLog, join(dir, "data", "verdicts.jsonl"));
  assert.equal(c.runRoot, "/abs/runs");
  assert.deepEqual(loadScenarios(c).base, BASE);
});

test("a cost command runs in the config file's folder (relative script argument)", () => {
  const dir = tmp();
  write(join(dir, "costs.mjs"), `process.stdout.write(JSON.stringify({ scenarios: { b: ${JSON.stringify(BASE)} } }));`);
  const cfg = write(join(dir, "local-config.json"), config({ command: [process.execPath, "costs.mjs"], base: "b" }));
  const c = readConfig(cfg);
  assert.equal(c.costs.cwd, dir);
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
  const realCfg = write(join(dir, "real", "local-config.json"), config({ file: "costs.json", base: "b" }));
  const link = join(dir, "home", ".config", "x", "local-config.json");
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(realCfg, link);
  const c = readConfig(link);
  assert.equal(c.verdictLog, join(dir, "real", "verdicts.jsonl"));
  assert.deepEqual(loadScenarios(c).base, BASE);
});

// --- template + validator -----------------------------------------------------

test("no config: status setup with the template path, never a default config", () => {
  const home = tmp();
  const r = resolveConfig({ HOME: home });
  assert.equal(r.status, "setup");
  assert.equal(r.configPath, defaultConfigPath({ HOME: home }));
  assert.equal(r.template, TEMPLATE_PATH);
  assert.match(r.reason, /no local config at .*copy the template/);
});

test("the unfilled template is named as setup, with every gap of the config at once", () => {
  const home = tmp();
  const path = defaultConfigPath({ HOME: home });
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(TEMPLATE_PATH, path);
  const r = resolveConfig({ HOME: home });
  assert.equal(r.status, "setup");
  assert.equal(r.reason, "COSTS_NOT_FILLED: costs not filled in: give a cost file or command, or confirm the example scenario");
  write(path, { costs: { file: "c.json", command: ["x"] } });
  const many = resolveConfig({ HOME: home }).reason;
  for (const gap of ["costs.base", "exactly one of costs.file, costs.command or costs.example", "verdictLog", "runRoot"])
    assert.ok(many.includes(gap), gap);
});

test("every missing, null, empty or non-numeric cost field is named; never filled with 0; an explicit 0 is kept", () => {
  const dir = tmp();
  const { stopLossSlippage, ...withoutStop } = BASE;
  write(join(dir, "costs.json"), { scenarios: { b: { ...withoutStop, entrySlippage: null, exitSlippage: "", closingFees: "2" } } });
  const cfg = write(join(dir, "local-config.json"), config({ file: "costs.json", base: "b" }));
  const r = resolveConfig({ HOME: dir, TRIAGE_CONFIG: cfg });
  assert.equal(r.status, "setup");
  assert.equal(r.reason, "BAD_COSTS: scenario b: entrySlippage, exitSlippage, stopLossSlippage, closingFees must be numbers >= 0");
  write(join(dir, "costs.json"), { scenarios: { b: { ...BASE, exitSlippage: 0 } } });
  assert.equal(resolveConfig({ HOME: dir, TRIAGE_CONFIG: cfg }).status, "ready");
  assert.equal(loadScenarios(readConfig(cfg)).base.exitSlippage, 0);
  write(join(dir, "costs.json"), { scenarios: { other: BASE } });
  assert.match(resolveConfig({ HOME: dir, TRIAGE_CONFIG: cfg }).reason, /scenario "b" not found/);
});

test("the filled template resolves ready with absolute paths (CLI)", () => {
  const home = tmp();
  const path = defaultConfigPath({ HOME: home });
  write(join(dirname(path), "costs.json"), { scenarios: { b: BASE } });
  const t = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
  write(path, { ...t, costs: { ...t.costs, file: "costs.json", base: "b" } });
  const out = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "", TRIAGE_CONFIG: "" } });
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout);
  assert.equal(r.status, "ready");
  assert.equal(r.costs.file, join(dirname(path), "costs.json"));
  assert.equal(r.verdictLog, join(dirname(path), "verdicts.jsonl"));
  assert.equal(r.runRoot, join(dirname(path), "runs"));
  const bad = spawnSync(process.execPath, [script, "setup"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^USAGE/);
});

// --- example costs --------------------------------------------------------------

test("costs-example.json: labelled, complete, a plain file without sha256 or private names", () => {
  const text = readFileSync(EXAMPLE_PATH, "utf8");
  const e = JSON.parse(text);
  assert.match(e.source, /\S/);
  assert.match(e.exportedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(e.description, /not your costs/);
  assert.deepEqual(Object.keys(e.scenarios), ["example"]);
  for (const f of COST_FIELDS) assert.equal(typeof e.scenarios.example[f], "number", f);
  assert.equal("sha256" in e, false);
  assert.doesNotMatch(text, /\/home\/|\.ya?ml/i);
});

test("example costs only with a recorded confirmation; then they load from the shipped file", () => {
  const dir = tmp();
  const cfg = write(join(dir, "local-config.json"), config({ example: {}, base: "example" }));
  assert.match(resolveConfig({ HOME: dir, TRIAGE_CONFIG: cfg }).reason, /costs\.example needs confirmedAt/);
  write(cfg, config({ example: { confirmedAt: "2026-01-01T00:00:00Z" }, base: "mine" }));
  assert.match(resolveConfig({ HOME: dir, TRIAGE_CONFIG: cfg }).reason, /costs\.base must be "example"/);
  write(cfg, config({ example: { confirmedAt: "2026-01-01T00:00:00Z" }, base: "example" }));
  assert.equal(resolveConfig({ HOME: dir, TRIAGE_CONFIG: cfg }).status, "ready");
  const sc = loadScenarios(readConfig(cfg));
  assert.equal(sc.example, true);
  assert.deepEqual(sc.base, JSON.parse(readFileSync(EXAMPLE_PATH, "utf8")).scenarios.example);
});


test("r69 #5: TRIAGE_CONFIG over an existing default that is another file is announced in note; the same file (symlink) or no default: no note", () => {
  const home = tmp();
  const cost = write(join(home, "c.json"), { scenarios: { b: BASE } });
  const other = write(join(home, "other", "local-config.json"), config({ file: cost, base: "b" }));
  const env = { HOME: home, TRIAGE_CONFIG: other };
  assert.equal(resolveConfig(env).note, undefined, "no default config");
  const def = write(defaultConfigPath({ HOME: home }), config({ file: cost, base: "b" }));
  assert.match(resolveConfig(env).note, new RegExp(`^TRIAGE_CONFIG ${other} overrides the config at ${def}`));
  rmSync(def);
  symlinkSync(other, def);
  assert.equal(resolveConfig(env).note, undefined, "the default is a symlink to the same file");
});

test("public hygiene: no tracked file of this skill, its scripts or its tests names a revision of the PRD", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const ls = spawnSync("git", ["ls-files", "skills/is-this-backtest-lambo-or-lada", "scripts/triage-*", "tests/triage-*", "tests/fixtures/triage"], { cwd: root, encoding: "utf8" });
  assert.equal(ls.status, 0, ls.stderr);
  const files = ls.stdout.split("\n").filter(Boolean);
  assert.ok(files.some((f) => f.startsWith("tests/")) && files.some((f) => f.startsWith("scripts/")), files.join(", "));
  const hits = files.filter((f) => /\bPRD\s+rev\b/i.test(readFileSync(join(root, f), "utf8")));
  assert.deepEqual(hits, []);
});
