import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { readConfig, loadScenarios } from "../scripts/triage-config.mjs";
import { applyRun, hasStop, intraMinuteOffered, runRequest, settingsFiles, strategyAsBuilt, main } from "../scripts/triage-run-request.mjs";
import * as rr from "../scripts/triage-run-request.mjs";

// One temp folder per test file, removed after the file's tests.
const ROOT = mkdtempSync(join(tmpdir(), "rr-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const here = dirname(fileURLToPath(import.meta.url));
const SKILL = join(here, "..", "skills", "is-this-backtest-lambo-or-lada");
const script = join(here, "..", "scripts", "triage-run-request.mjs");

// Synthetic cost scenarios in Option Omega field values (no real values).
const COSTS = {
  scenarios: {
    base: {
      entrySlippage: 0.3,
      exitSlippage: 0,
      stopLossSlippage: 0.6,
      openingFees: 2,
      closingFees: 2,
    },
    stress: {
      entrySlippage: 0.9,
      exitSlippage: 0.1,
      stopLossSlippage: 1.2,
      openingFees: 3,
      closingFees: 3,
    },
  },
};

// The rule-sheet template for settings saved from Option Omega (no pre-run gate).
function savedSheet() {
  const t = JSON.parse(readFileSync(join(SKILL, "templates", "rule-sheet.json"), "utf8"));
  t.source.built_from = "saved backtest";
  return JSON.stringify(t);
}

function setup(costs = {}) {
  const dir = mkdtempSync(join(ROOT, "rr-"));
  const costFile = join(dir, "costs.json");
  writeFileSync(costFile, JSON.stringify(COSTS));
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      costs: { file: costFile, base: "base", ...costs },
      verdictLog: "verdicts.jsonl",
      runRoot: "runs",
    }),
  );
  return { dir, configPath, costFile };
}

function settings(overrides = {}) {
  return {
    parameters: {
      underlying: "SPX",
      rangeStart: "2022-01-03",
      rangeEnd: "2025-12-31",
      startingFunds: 500000,
      legs: [
        { type: "Put", buySell: "Sell", daysToExpiration: 0, metricType: "Delta", delta: 10 },
        { type: "Put", buySell: "Buy", daysToExpiration: 0, metricType: "Delta", delta: 5 },
      ],
      entryTime: "10:00:00",
      exitConditions: [
        {
          maxLoss: 200,
          maxProfit: 50,
          useIntraMinuteStop: true,
          useProfitActions: true,
        },
      ],
      entrySlippage: 0.05,
      exitSlippage: 0.05,
      stopLossSlippage: 0.1,
      openingFees: 0.6,
      closingFees: 0.6,
      entryMinVix: 15,
      entryMaxVix: null,
      useOpeningRangeBreakout: true,
      reentryConditions: [{ x: 1 }],
      maxContractsPerTrade: 2,
      ...overrides,
    },
  };
}

test("author costs off the base: the author run, author_base, naive, cost_2x", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const out = runRequest(settings(), sc, "X");
  assert.deepEqual(out.flags, {
    author_costs_match_base: false,
    author_without_intra_minute: false,
    author_has_stop: true,
  });
  // V1.1: the author has a stop (maxLoss 200), so the two stop neighbours follow.
  assert.deepEqual(
    out.runs.map((r) => r.role),
    ["author", "author_base", "naive", "cost_2x", "stop_tight", "stop_wide"],
  );
  const [, ab, naive, c2] = out.runs;
  assert.deepEqual(ab.set, COSTS.scenarios.base);
  // naive: base costs, levers off, fixed size
  assert.equal(naive.set.entrySlippage, 0.3);
  assert.equal(naive.set.entryMinVix, null);
  assert.equal(
    "entryMaxVix" in naive.set,
    false,
    "unset filters are left alone",
  );
  assert.equal(naive.set.useOpeningRangeBreakout, false);
  assert.deepEqual(naive.set.reentryConditions, []);
  assert.equal(
    "maxContractsPerTrade" in naive.set,
    false,
    "unchanged fields are not listed",
  );
  assert.equal(
    runRequest(settings({ maxContractsPerTrade: 0 }), sc, "X").runs[2].set
      .maxContractsPerTrade,
    1,
  );
  assert.equal(naive.exitConditions[0].maxLoss, null);
  assert.equal(naive.exitConditions[0].maxProfit, null);
  assert.equal(naive.exitConditions[0].useProfitActions, false);
  // cost_2x = base slippage x 2, base fees
  assert.deepEqual(c2.set, {
    entrySlippage: 0.6,
    exitSlippage: 0,
    stopLossSlippage: 1.2,
    openingFees: 2,
    closingFees: 2,
  });
  // naive has no stop left, and Option Omega refuses intra-minute stops without one.
  assert.equal(naive.exitConditions[0].useIntraMinuteStop, false);
  // Only real changes: naive's exit group lists no field the author already has.
  assert.equal("isTrailingStopLoss" in naive.exitConditions[0], true);
  const quiet = runRequest(
    settings({
      exitConditions: [
        { maxLoss: 200, isTrailingStopLoss: false, useIntraMinuteStop: true },
      ],
    }),
    sc,
    "X",
  ).runs[2];
  assert.equal("isTrailingStopLoss" in quiet.exitConditions[0], false);
});

test("author on the base costs: no author_base", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const out = runRequest(settings({ ...COSTS.scenarios.base }), sc, "X");
  assert.equal(out.flags.author_costs_match_base, true);
  assert.deepEqual(out.runs.map((r) => r.role), ["author", "naive", "cost_2x", "stop_tight", "stop_wide"]);
});

test("rev226: cost_2x is always base slippage x 2 with base fees", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const b = COSTS.scenarios.base;
  assert.deepEqual(sc.cost2x, {
    entrySlippage: b.entrySlippage * 2,
    exitSlippage: b.exitSlippage * 2,
    stopLossSlippage: b.stopLossSlippage * 2,
    openingFees: b.openingFees,
    closingFees: b.closingFees,
  });
  assert.equal(sc.cost2xName, "base x2 slippage");
});

test("rev248: Option Omega offers intra-minute stops per exit group only for SPX/SPY with every leg of the group at 0 DTE", () => {
  const legs = [{ id: "p", daysToExpiration: 0 }, { id: "c", daysToExpiration: 0 }, { id: "w", daysToExpiration: 7 }];
  const p = { underlying: "SPX", legs };
  assert.equal(intraMinuteOffered(p, { legIds: ["p", "c"] }), true);
  assert.equal(intraMinuteOffered(p, { legIds: ["p", "w"] }), false);
  assert.equal(intraMinuteOffered({ ...p, underlying: "SPY" }, { legIds: ["p"] }), true);
  assert.equal(intraMinuteOffered({ ...p, underlying: "QQQ" }, { legIds: ["p"] }), false);
  // A group without legIds covers every leg.
  assert.equal(intraMinuteOffered(p, {}), false);
  assert.equal(intraMinuteOffered({ underlying: "SPX", legs: legs.slice(0, 2) }, {}), true);
});

test("rev248: the author run keeps intra-minute stops unless the rule sheet states minute; author_base, naive and cost_2x always use them where offered", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const off = settings({ exitConditions: [{ maxLoss: 200, useIntraMinuteStop: false }] });
  const on = [{ useIntraMinuteStop: true }];
  const role = (out, r) => out.runs.find((x) => x.role === r);
  // Nothing stated: the author run gets them too (the trade log of a minute run is too positive).
  const plain = runRequest(off, sc, "X", {});
  assert.equal(plain.flags.author_without_intra_minute, false);
  assert.deepEqual(role(plain, "author"), { role: "author", label: "X", set: {}, exitConditions: on, why: role(plain, "author").why });
  for (const r of ["author_base", "cost_2x"]) assert.deepEqual(role(plain, r).exitConditions[0].useIntraMinuteStop, true, r);
  assert.equal("useIntraMinuteStop" in role(plain, "naive").exitConditions[0], false, "naive: no stop, stays false");
  // Assumed is not stated.
  assert.deepEqual(role(runRequest(off, sc, "X", { stop_mode: { value: "minute", status: "assumed" } }), "author").exitConditions, on);
  // Stated minute: the author run stays as it is, every check run still with intra-minute stops.
  const minute = runRequest(off, sc, "X", { stop_mode: { value: "minute", status: "stated" } });
  assert.equal(minute.flags.author_without_intra_minute, true);
  assert.equal(role(minute, "author").exitConditions, undefined, "the author run is always listed, here without a change");
  for (const r of ["author_base", "cost_2x"]) assert.equal(role(minute, r).exitConditions[0].useIntraMinuteStop, true, r);
  // Stated minute on settings with intra-minute stops: the author run is switched to minute.
  const toMinute = runRequest(settings(), sc, "X", { stop_mode: { value: "minute", status: "stated" } });
  assert.deepEqual(role(toMinute, "author").exitConditions, [{ useIntraMinuteStop: false }]);
  assert.equal(toMinute.flags.author_without_intra_minute, true);
  // Where Option Omega does not offer them nothing changes.
  const qqq = runRequest(settings({ underlying: "QQQ", exitConditions: [{ maxLoss: 200, useIntraMinuteStop: false }] }), sc, "X", {});
  assert.equal(role(qqq, "author").exitConditions, undefined);
  assert.equal(qqq.flags.author_without_intra_minute, false);
  assert.equal("useIntraMinuteStop" in (role(qqq, "cost_2x").exitConditions?.[0] ?? {}), false);
  // The author's settings file carries the change.
  const files = settingsFiles(off.parameters, plain.runs);
  assert.equal(files.author.exitConditions[0].useIntraMinuteStop, true);
  assert.equal(files.cost_2x.exitConditions[0].useIntraMinuteStop, true);
});

test("intra-minute stops only on exit groups with a stop (Option Omega refuses them without one)", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const role = (out, r) => out.runs.find((x) => x.role === r);
  assert.equal(hasStop({ maxLoss: 200 }), true);
  assert.equal(hasStop({ maxLoss: null }), false);
  assert.equal(hasStop({ useProfitActions: true, profitActions: [{ stopLoss: 50 }] }), true);
  // A time action's stopLoss alone: Option Omega refuses intra-minute (validation run).
  assert.equal(hasStop({ useTimeActions: true, timeActions: [{ stopLoss: 20 }] }), false);
  assert.equal(hasStop({ useProfitActions: false, profitActions: [{ stopLoss: 50 }] }), false, "a switched-off action stops nothing");
  assert.equal(hasStop({ useProfitActions: true, profitActions: [{ profitTarget: 50 }] }), false);
  // A run without any stop (naive): no intra-minute flag on any group.
  const out = runRequest(settings(), sc, "X", {});
  for (const g of role(out, "naive").exitConditions) assert.equal(g.useIntraMinuteStop, false);
  // A group with only a profit-action stop: on in the check runs, off in naive (actions off there).
  const pa = settings({ exitConditions: [{ maxLoss: null, useIntraMinuteStop: false, useProfitActions: true, profitActions: [{ stopLoss: 50 }] }] });
  const o2 = runRequest(pa, sc, "X", {});
  for (const r of ["author", "author_base", "cost_2x"]) assert.equal(role(o2, r).exitConditions[0].useIntraMinuteStop, true, r);
  assert.equal("useIntraMinuteStop" in role(o2, "naive").exitConditions[0], false);
  // A group without a stop gets false, also in the author run.
  const none = runRequest(settings({ exitConditions: [{ maxLoss: null, maxProfit: 50, useIntraMinuteStop: true }] }), sc, "X", {});
  for (const r of ["author", "author_base", "cost_2x"]) assert.equal(role(none, r).exitConditions[0].useIntraMinuteStop, false, r);
  assert.equal(none.flags.author_without_intra_minute, false);
});

test("an exit group without the useIntraMinuteStop key counts as false: no non-change is listed", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const two = (extra) => settings({ exitConditions: [{ maxLoss: 200, useIntraMinuteStop: true }, { maxProfit: 50 }], ...extra });
  const author = (sheet) => runRequest(two(), sc, "X", sheet).runs.find((r) => r.role === "author");
  assert.deepEqual(author({ stop_mode: { value: "minute", status: "stated" } }).exitConditions, [{ useIntraMinuteStop: false }]);
  assert.equal(author({}).exitConditions, undefined);
});

test("CLI prints the request and writes run-request.json into the run folder", () => {
  const { dir, configPath } = setup();
  const folder = join(dir, "run");
  const s = join(dir, "settings.json");
  writeFileSync(s, JSON.stringify(settings()));
  const noSheet = spawnSync(process.execPath, [script, "--settings", s, "--author-label", "X", "--run-folder", folder], {
    encoding: "utf8",
    env: { ...process.env, TRIAGE_CONFIG: configPath },
  });
  // Step 2 saves the rule sheet first: its stop mode decides the author run's intra-minute stops.
  assert.match(noSheet.stderr, /^BAD_RULE_SHEET: .*rule-sheet\.json/);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "rule-sheet.json"), savedSheet());
  const out = spawnSync(
    process.execPath,
    [script, "--settings", s, "--author-label", "X", "--run-folder", folder],
    {
      encoding: "utf8",
      env: { ...process.env, TRIAGE_CONFIG: configPath },
    },
  );
  assert.equal(out.status, 0, out.stderr);
  // author, author_base, naive, cost_2x and (V1.1, the author has a stop) stop_tight, stop_wide.
  assert.equal(JSON.parse(out.stdout).runs.length, 6);
  // The hand-off file: the verdict reads it from the run folder, nothing is copied by hand.
  assert.deepEqual(JSON.parse(readFileSync(join(folder, "run-request.json"), "utf8")), JSON.parse(out.stdout));
  const bad = spawnSync(process.execPath, [script, "--settings", s], {
    encoding: "utf8",
    env: { ...process.env, TRIAGE_CONFIG: configPath },
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^USAGE/);
});

test("v2 fix 3: naive switches off every lever not on the keep list (fail closed)", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const s = settings({
    allocationPercentage: 5,
    capProfits: true,
    capLosses: true,
    maxOpenTrades: 3,
    useOpeningRangeBreakoutHighLow: true,
    exitConditions: [
      {
        maxLoss: 200,
        isMaxLossPerLeg: true,
        legExitDeltas: [{ leg: 1, delta: 30 }],
        exitUnderlyingPriceMoveUp: 1.5,
        profitType: "ClosingOrder",
      },
    ],
    someFutureLever: true,
    someFutureMode: "On",
  });
  const naive = runRequest(s, sc, "X").runs.find((r) => r.role === "naive");
  assert.equal(naive.set.allocationPercentage, 0);
  assert.equal(naive.set.capProfits, false);
  assert.equal(naive.set.capLosses, false);
  assert.equal(naive.set.maxOpenTrades, null);
  assert.equal(naive.set.useOpeningRangeBreakoutHighLow, false);
  assert.equal(naive.set.someFutureLever, false);
  const g = naive.exitConditions[0];
  assert.equal(g.isMaxLossPerLeg, false);
  assert.deepEqual(g.legExitDeltas, []);
  assert.equal(g.exitUnderlyingPriceMoveUp, null);
  assert.equal("profitType" in g, false, "unit fields stay");
  // An unknown text field cannot be switched off safely: it is listed for review.
  assert.deepEqual(naive.reviewByHand, ["someFutureMode"]);
  // Entry day/time and structure stay.
  assert.equal("legs" in naive.set, false);
  assert.equal("entryTime" in naive.set, false);
});

test("naive alloc 0 comes with ignoreMarginRequirements true (OO refuses alloc 0 otherwise)", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const s = settings({ allocationPercentage: 5, ignoreMarginRequirements: false });
  const out = runRequest(s, sc, "X");
  const naive = out.runs.find((r) => r.role === "naive");
  assert.equal(naive.set.allocationPercentage, 0);
  assert.equal(naive.set.ignoreMarginRequirements, true);
  // The other runs keep the author's setting.
  const base = out.runs.find((r) => r.role === "author_base");
  assert.equal("ignoreMarginRequirements" in (base.set ?? {}), false);
});

test("a credit structure with a long child leg on the inner side is refused; a debit one is not", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const leg = (id, type, buySell, extra = {}) => ({ id, type, buySell, daysToExpiration: 0, quantity: 1, ...extra });
  const child = (parentId, off) => ({ metricType: "ChildLeg", parentId, childMetricType: "ParentOffset", parentStrikeOffset: off });
  const ic = (putOff, callOff) =>
    settings({
      legs: [
        leg("sp", "Put", "Sell", { metricType: "SpreadPremium", spreadPremium: 1.5 }),
        leg("lp", "Put", "Buy", child("sp", putOff)),
        leg("sc", "Call", "Sell", { metricType: "SpreadPremium", spreadPremium: 1.5 }),
        leg("lc", "Call", "Buy", child("sc", callOff)),
      ],
    });
  const credit = { structure: { value: "iron condor (put spread + call spread)", status: "stated" } };
  assert.throws(() => runRequest(ic(55, 55), sc, "X", credit), /INVERTED_SPREAD: lp \(Put\) sits on the inner side of sp/);
  assert.throws(
    () => runRequest(ic(-55, -55), sc, "X", { structure: { value: "put credit spread + call credit spread", status: "stated" } }),
    /INVERTED_SPREAD: lc /,
  );
  assert.doesNotThrow(() => runRequest(ic(-55, 55), sc, "X", credit));
  // A debit structure, or a rule sheet without a structure, is not refused.
  assert.doesNotThrow(() => runRequest(ic(55, -55), sc, "X", { structure: { value: "put debit spread + call debit spread", status: "stated" } }));
  assert.doesNotThrow(() => runRequest(ic(55, 55), sc, "X"));
});

test("review A: credit/debit and the refusal also for StrikeOffset and Delta legs; otherwise not determinable", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const leg = (id, type, buySell, extra) => ({ id, type, buySell, daysToExpiration: 0, quantity: 1, ...extra });
  const off = (v) => ({ metricType: "StrikeOffset", strikeOffset: v });
  const delta = (v) => ({ metricType: "Delta", delta: v });
  const ic = (lp, others = [off(-50), off(50), off(70)]) =>
    settings({ legs: [leg("sp", "Put", "Sell", others[0]), leg("lp", "Put", "Buy", lp), leg("sc", "Call", "Sell", others[1]), leg("lc", "Call", "Buy", others[2])] });
  const credit = { structure: { value: "iron condor", status: "stated" } };
  // Reviewer A: StrikeOffset IC with the long put inside the short put (a debit put spread).
  assert.throws(() => runRequest(ic(off(-30)), sc, "X", credit), /INVERTED_SPREAD: lp /);
  assert.doesNotThrow(() => runRequest(ic(off(-70)), sc, "X", credit));
  const asBuilt = (s) => strategyAsBuilt(s.parameters, {}, {});
  assert.match(asBuilt(ic(off(-70))), /put spread S P \/ B P: credit; call spread S C \/ B C: credit/);
  assert.match(asBuilt(ic(off(-30))), /put spread S P \/ B P: debit/);
  // Both delta: credit when the short leg is nearer the money (the larger delta).
  const deltas = [delta(20), delta(20), delta(10)];
  assert.doesNotThrow(() => runRequest(ic(delta(10), deltas), sc, "X", credit));
  assert.match(asBuilt(ic(delta(10), deltas)), /put spread S P \/ B P: credit; call spread S C \/ B C: credit/);
  assert.throws(() => runRequest(ic(delta(30), deltas), sc, "X", credit), /INVERTED_SPREAD: lp /);
  // Different references: not derivable from the settings, never refused.
  const mixed = ic(delta(10), [{ metricType: "SpreadPremium", spreadPremium: 1 }, off(50), off(70)]);
  assert.doesNotThrow(() => runRequest(mixed, sc, "X", credit));
  assert.match(asBuilt(mixed), /put spread S P \/ B P: credit\/debit: not determinable; call spread S C \/ B C: credit/);
});

test("strategy-as-built.md: the author settings in Option Omega's run-summary layout; assumed rule-sheet fields marked", () => {
  const leg = (id, type, buySell, extra = {}) => ({ id, type, buySell, daysToExpiration: 0, quantity: 1, ...extra });
  const child = (parentId, off) => ({ metricType: "ChildLeg", parentId, childMetricType: "ParentOffset", parentStrikeOffset: off });
  const group = (id, name, legIds) => ({ id, name, legIds, maxLoss: 100, lossType: "Percentage", useIntraMinuteStop: true });
  // The legs of the Tom settings (credit IC) and of blind6's refused-v1 (put child +55).
  const ic = (putOff) => ({
    underlying: "SPX", rangeStart: "2023-01-01", rangeEnd: "2025-09-05", startingFunds: 100000,
    entryTime: "11:00:00", additionalEntryTimes: ["11:45:00", "12:30:00"],
    legs: [
      leg("sp", "Put", "Sell", { metricType: "SpreadPremium", spreadPremium: 1.5 }),
      leg("lp", "Put", "Buy", child("sp", putOff)),
      leg("sc", "Call", "Sell", { metricType: "SpreadPremium", spreadPremium: 1.5 }),
      leg("lc", "Call", "Buy", child("sc", 55)),
    ],
    exitConditions: [group("gp", "Put side", ["sp", "lp"]), group("gc", "Call side", ["sc", "lc"])],
    allocationPercentage: 0, maxContractsPerTrade: 1, ignoreMarginRequirements: true, capLosses: false, entryMaxVix: 30,
  });
  // Core fields are stated or the gate stops; only defaults (here sizing) can still be marked.
  const sheet = { ...Object.fromEntries(C1.coreFields.map((f) => [f, { status: "stated" }])), sizing: { status: "assumed" } };
  const rr = { baseScenario: "example", costsExample: true };
  const tom = strategyAsBuilt(ic(-55), sheet, rr);
  // Option Omega's run-summary layout: Legs, Entry, Exit, Misc.
  assert.deepEqual(tom.match(/^## .*/gm), ["## Legs", "## Entry", "## Exit", "## Misc"]);
  assert.match(tom, /^- S P 1 · spread premium \$1\.5 · 0 DTE$/m);
  assert.match(tom, /^- B P 1 · 55 below S P · 0 DTE/m);
  assert.match(tom, /^- B C 1 · 55 above S C · 0 DTE/m);
  assert.match(tom, /put spread S P \/ B P: credit; call spread S C \/ B C: credit/);
  assert.match(tom, /^- Time: 11:00, 11:45, 12:30$/m);
  assert.match(tom, /^- Days: every trading day$/m);
  assert.match(tom, /^- Allocation: 0%, margin ignored \*\(assumed: sizing\)\*$/m);
  assert.match(tom, /^- Contracts per trade: 1 per entry, fixed$/m);
  assert.match(tom, /^- Filters: entryMaxVix 30$/m);
  assert.match(tom, /^- Put side \(S P, B P\): profit target none; stop loss 100%, intra-minute; exit time none \(otherwise held to expiry\)$/m);
  assert.match(tom, /2023-01-01 to 2025-09-05/);
  assert.match(tom, /^- Opening fees: not stated; closing fees: not stated/m);
  assert.match(tom, /^- Entry slippage: not stated; exit slippage: not stated; stop slippage: not stated$/m);
  assert.match(tom, /^- The checks run at example costs \(not your own\)$/m);
  assert.doesNotMatch(tom, /stop.*assumed|capLosses/);
  assert.ok(tom.split("\n").length <= 30, "one screen");
  // Profit target, exit time and the author's own costs as Option Omega lists them.
  const tp = ic(-55);
  Object.assign(tp.exitConditions[0], { maxProfit: 50, profitType: "Percentage", exitTime: "15:45:00" });
  Object.assign(tp, { openingFees: 0.65, entrySlippage: 0.05 });
  const t2 = strategyAsBuilt(tp, {}, { baseScenario: "base" });
  assert.match(t2, /profit target 50%; stop loss 100%, intra-minute; exit time 15:45$/m);
  assert.match(t2, /Opening fees: \$0\.65; .*Entry slippage: \$0\.05; /s);
  assert.match(t2, /The checks run at your base costs/);
  // blind6 refused-v1: the put long leg above the short put builds a debit spread.
  const b6 = strategyAsBuilt(ic(55), {}, rr);
  assert.match(b6, /^- B P 1 · 55 above S P · 0 DTE/m);
  assert.match(b6, /put spread S P \/ B P: debit; call spread S C \/ B C: credit/);
});

test("rev210 R6: explicit zeros are named; author settings without a cost field never match the base", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const out = runRequest(settings(), sc, "X");
  // COSTS.scenarios.base has exitSlippage 0 (explicit): named, also in the 2x scenario.
  // The 2x run mirrors the base (0 x 2 = 0, base fees): only base fields are named.
  assert.deepEqual(out.zeroCostFields, ["base.exitSlippage"]);
  const p = settings({ ...COSTS.scenarios.base }).parameters;
  delete p.closingFees;
  assert.equal(runRequest({ parameters: p }, sc, "X").flags.author_costs_match_base, false);
});

test("rev210 R6: the shipped cost template has every required field and no values", () => {
  const t = JSON.parse(readFileSync(join(here, "..", "skills", "is-this-backtest-lambo-or-lada", "templates", "costs.json"), "utf8"));
  for (const s of Object.values(t.scenarios)) {
    for (const f of ["entrySlippage", "exitSlippage", "stopLossSlippage", "openingFees", "closingFees"]) {
      assert.ok(f in s, f);
      assert.notEqual(typeof s[f], "number", `${f} must not carry a default value`);
    }
  }
});

test("rev214: every run keeps the author's OO date range (the C4 coverage); O3: a missing one is refused", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const s = settings();
  const p = s.parameters ?? s;
  p.rangeStart = "2022-06-01";
  p.rangeEnd = "2026-11-06";
  assert.deepEqual(runRequest(s, sc, "X").range, { from: "2022-06-01", through: "2026-11-06" });
  delete p.rangeEnd;
  assert.throws(() => runRequest(s, sc, "X"), /^Error: BAD_SETTINGS: .*rangeStart and rangeEnd/);
});

test("run request: costsExample true only for a config on the confirmed shipped example", () => {
  const { dir, configPath } = setup();
  const s = join(dir, "settings.json");
  writeFileSync(s, JSON.stringify(settings()));
  mkdirSync(join(dir, "run"));
  writeFileSync(join(dir, "run", "rule-sheet.json"), savedSheet());
  const run = (cfg) => main(["--settings", s, "--author-label", "X", "--run-folder", join(dir, "run")], { HOME: dir, TRIAGE_CONFIG: cfg });
  assert.equal(run(configPath).costsExample, false);
  const ex = join(dir, "example.json");
  writeFileSync(ex, JSON.stringify({ costs: { example: { confirmedAt: "2026-01-01T00:00:00Z" }, base: "example" }, verdictLog: "v.jsonl", runRoot: "runs" }));
  const out = run(ex);
  assert.equal(out.costsExample, true);
  assert.equal(out.baseScenario, "example");
});

test("the output carries what the verdict reads; P6: the base and the computed 2x cost values themselves", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const out = runRequest(settings(), sc, "X");
  for (const f of ["flags", "baseScenario", "cost2xName", "costsExample", "costs", "zeroCostFields", "range", "c8Starts", "returnBasis"])
    assert.ok(f in out, f);
  assert.equal(out.cost2xName, "base x2 slippage");
  assert.deepEqual(out.costs, { base: COSTS.scenarios.base, cost2x: { ...COSTS.scenarios.base, entrySlippage: 0.6, stopLossSlippage: 1.2 } });
});

// --- settings files ---------------------------------------

function folderRun(overrides = {}) {
  const { dir, configPath } = setup();
  const folder = join(dir, "run");
  mkdirSync(folder);
  writeFileSync(join(folder, "rule-sheet.json"), savedSheet());
  const s = join(dir, "settings.json");
  writeFileSync(s, JSON.stringify(settings(overrides)));
  const run = (argv) => main(argv, { HOME: dir, TRIAGE_CONFIG: configPath });
  return { dir, folder, s, run };
}

test("the run request writes <role>.settings.json per role: the author's settings plus exactly the listed changes", () => {
  const { folder, s, run } = folderRun();
  const out = run(["--settings", s, "--author-label", "X", "--run-folder", folder]);
  const author = settings().parameters;
  const files = readdirSync(folder).filter((f) => f.endsWith(".settings.json")).sort();
  assert.deepEqual(files, out.runs.map((r) => r.role).sort().map((r) => `${r}.settings.json`));
  assert.deepEqual(JSON.parse(readFileSync(join(folder, "author.settings.json"), "utf8")), author);
  // The pre-run question shows this file: built by the script from author.settings.json, never by the LLM.
  const sheet = JSON.parse(readFileSync(join(folder, "rule-sheet.json"), "utf8"));
  assert.equal(readFileSync(join(folder, "strategy-as-built.md"), "utf8"), strategyAsBuilt(author, sheet.rule_sheet ?? {}, out, sheet.source));
  for (const r of out.runs) {
    const applied = JSON.parse(readFileSync(join(folder, `${r.role}.settings.json`), "utf8"));
    const expected = structuredClone(author);
    Object.assign(expected, r.set);
    (r.exitConditions ?? []).forEach((g, i) => Object.assign(expected.exitConditions[i], g));
    assert.deepEqual(applied, expected, r.role);
  }
});

test("a non-empty reviewByHand stops before any settings file is written", () => {
  const { folder, s, run } = folderRun({ breakoutTrigger: "custom" });
  assert.throws(
    () => run(["--settings", s, "--author-label", "X", "--run-folder", folder]),
    /^Error: REVIEW_BY_HAND: naive: breakoutTrigger/,
  );
  assert.ok(existsSync(join(folder, "run-request.json")), "the request itself is written, so the fields can be checked");
  assert.deepEqual(readdirSync(folder).filter((f) => f.endsWith(".settings.json")), []);
});

test("templates: plugin-result.json and rule-sheet.json name exactly the interface fields", () => {
  const pr = JSON.parse(readFileSync(join(SKILL, "templates", "plugin-result.json"), "utf8"));
  assert.deepEqual(Object.keys(pr).filter((k) => !k.startsWith("_")), ["block_id", "runs"]);
  assert.deepEqual(Object.keys(pr.runs.author), ["label", "capture_id"]);
  const rs = JSON.parse(readFileSync(join(SKILL, "templates", "rule-sheet.json"), "utf8"));
  assert.deepEqual(Object.keys(rs.rule_sheet).length, 14);
  assert.deepEqual(Object.keys(rs.rule_sheet.stop_mode), ["value", "status", "quote"]);
  assert.deepEqual(Object.keys(rs.source), ["ref", "built_from", "description"]);
  assert.doesNotMatch(rs.rule_sheet.stop.value, /minute/, "stop keeps type and value only");
});

// --- author settings as a file ------------------------------------

test("rev242: the author settings file is taken as is (from a description or saved from Option Omega) and author.settings.json is it unchanged", () => {
  const { dir, folder, run } = folderRun();
  const plain = join(dir, "author-in.json");
  writeFileSync(plain, JSON.stringify(settings().parameters));
  const out = run(["--settings", plain, "--author-label", "X", "--run-folder", folder]);
  const files = settingsFiles(settings().parameters, out.runs);
  assert.deepEqual(Object.keys(files), out.runs.map((r) => r.role));
  assert.deepEqual(files.author, settings().parameters);
  for (const [role, p] of Object.entries(files))
    assert.deepEqual(JSON.parse(readFileSync(join(folder, `${role}.settings.json`), "utf8")), p, role);
  assert.deepEqual(applyRun(settings().parameters, { role: "author", set: {} }), settings().parameters);
});


test("rev293: intra-minute is read on the complete strategy; an empty legIds is the group over every leg; a move exit alone gets none (Option Omega refuses it)", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const role = (out, r) => out.runs.find((x) => x.role === r);
  // A 0 DTE SPX iron fly: one group, legIds empty (= every leg), stop = 20-point underlying move, no maxLoss.
  const leg = (id, type, buySell, extra) => ({ id, type, buySell, quantity: 1, daysToExpiration: 0, ...extra });
  const move = { exitUnderlyingPriceMoveUp: 20, exitUnderlyingPriceMoveDown: 20, exitUnderlyingPriceMoveType: "Points" };
  const fly = (group) => ({
    underlying: "SPX", rangeStart: "2023-01-03", rangeEnd: "2025-09-05", startingFunds: 100000,
    legs: [
      leg("put-short", "Put", "Sell", { metricType: "StrikeOffset", strikeOffset: 0 }),
      leg("put-long", "Put", "Buy", { metricType: "ChildLeg", parentId: "put-short", childMetricType: "ParentOffset", parentStrikeOffset: -50 }),
      leg("call-short", "Call", "Sell", { metricType: "StrikeOffset", strikeOffset: 0 }),
      leg("call-long", "Call", "Buy", { metricType: "ChildLeg", parentId: "call-short", childMetricType: "ParentOffset", parentStrikeOffset: 50 }),
    ],
    exitConditions: [{ id: "fly", name: "Iron fly", legIds: [], ...group, useIntraMinuteStop: false }],
    maxContractsPerTrade: 1, allocationPercentage: 0, ignoreMarginRequirements: true,
  });
  // An empty legIds is Option Omega's single group over every leg.
  assert.equal(intraMinuteOffered(fly(move), fly(move).exitConditions[0]), true);
  // Move exit alone: Option Omega answers "useIntraMinuteStop needs a stop loss", so nothing changes.
  for (const g of [move, { exitWhenPutTested: true, exitWhenCallTested: true }]) {
    assert.equal(hasStop(g), false);
    const out = runRequest({ parameters: fly(g) }, sc, "Fly", {});
    for (const r of ["author", "author_base", "cost_2x"]) assert.equal(role(out, r).exitConditions, undefined, r);
  }
  // With a stop loss in the same group (legIds empty): on in every check run and the author run.
  const stopped = fly({ ...move, maxLoss: 100, lossType: "Percentage" });
  const out = runRequest({ parameters: stopped }, sc, "Fly", {});
  for (const r of ["author", "author_base", "cost_2x"]) assert.deepEqual(role(out, r).exitConditions, [{ useIntraMinuteStop: true }], r);
  assert.equal("useIntraMinuteStop" in role(out, "naive").exitConditions[0], false, "naive: no stop left");
  const files = settingsFiles(stopped, out.runs);
  assert.equal(files.author.exitConditions[0].useIntraMinuteStop, true);
  assert.equal(files.naive.exitConditions[0].useIntraMinuteStop, false);
  assert.match(strategyAsBuilt(files.author), /^- Iron fly: profit target none; stop loss 100%, intra-minute; /m);
  // A switched-on time action with a stopLoss as the only stop: Option Omega answered "useIntraMinuteStop needs a stop loss", so nothing changes.
  const timed = fly({ lossType: "Percentage", useTimeActions: true, timeActions: [{ dte: 0, time: "12:00:00", stopLoss: 100 }] });
  const ot = runRequest({ parameters: timed }, sc, "Fly", {});
  for (const r of ["author", "author_base", "cost_2x"]) assert.equal(role(ot, r).exitConditions, undefined, r);
  // Stated minute: the author run stays on minute stops, the flag is set.
  const minute = runRequest({ parameters: stopped }, sc, "Fly", { stop_mode: { value: "minute", status: "stated" } });
  assert.equal(role(minute, "author").exitConditions, undefined);
  assert.equal(minute.flags.author_without_intra_minute, true);
});

// Top-level fields of a real Option Omega settings file (cost fields left out): set switches that are not entry filters.
const REAL_TOP = {
  strikeOffsetType: "CurrentPrice", useExactDte: true, allocationPercentage: 100, pruneOldestTrades: false, maxContractsPerTrade: 1,
  ignoreMarginRequirements: true, useFloatingEntryTime: false, weeklyEntries: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
  monthlyEntryDay: "None", monthlyEntryOrdinal: 0, entryVixMoveType: "Percentage", entryGapType: "Percentage", entryMoveType: "Percentage",
  entryVixGapType: "Percentage", useOpeningRangeBreakout: false, breakoutCondition: "Both", useOpeningRangeBreakoutHighLow: false,
  ignoreWideBidAskTrades: false, closeOpenTradesAtTestCompletion: true, capProfits: false, capLosses: false, isEntryPremiumDebit: false,
  requireTwoPricesForProfitTarget: false, requireTwoPricesForStopLoss: false, reentryConditions: [], blackoutDays: null,
};
test("F2: strategy-as-built names only entry filters as Filters; re-entry and other switches as what they are", () => {
  const leg = (id, type, buySell) => ({ id, type, buySell, quantity: 1, daysToExpiration: 0, metricType: "Delta", delta: 10 });
  const p = (top = {}) => ({
    underlying: "SPX", rangeStart: "2025-03-03", rangeEnd: "2025-03-14", startingFunds: 500000, entryTime: "10:07:00",
    legs: [leg("sp", "Put", "Sell"), leg("sc", "Call", "Sell")], exitConditions: [{ legIds: [], maxLoss: 100, lossType: "Percentage" }], ...REAL_TOP, ...top,
  });
  const real = strategyAsBuilt(p());
  assert.match(real, /^- Filters: none$/m);
  assert.match(real, /^- Re-entry: none$/m);
  assert.match(real, /^- Other settings: closeOpenTradesAtTestCompletion true$/m);
  assert.doesNotMatch(real.split("## Exit")[0], /closeOpenTradesAtTestCompletion/);
  // Real entry filters (with the switches that only qualify them), re-entry, other switches; a qualifier without its filter has no effect.
  const mixed = strategyAsBuilt(p({
    entryMaxVix: 30, useOpeningRangeBreakout: true, minEntryPremium: 1, isEntryPremiumDebit: true, ignoreWideBidAskTrades: true,
    entrySmaLength: 200, reentryConditions: ["StopLoss"], maxDailyReentries: 2, capProfits: true, requireTwoPricesForStopLoss: true, closeOpenTradesAtTestCompletion: false,
  }));
  assert.match(mixed, /^- Filters: useOpeningRangeBreakout true, breakoutCondition "Both", isEntryPremiumDebit true, entryMaxVix 30, minEntryPremium 1$/m);
  assert.match(mixed, /^- Re-entry: reentryConditions \["StopLoss"\], maxDailyReentries 2$/m);
  assert.match(mixed, /^- Other settings: capProfits true, requireTwoPricesForStopLoss true$/m);
  assert.doesNotMatch(mixed, /entrySmaLength/);
  assert.match(mixed, /^- Quote quality: ignoreWideBidAskTrades true \(kept in every run\)$/m);
  assert.doesNotMatch(strategyAsBuilt(p({ closeOpenTradesAtTestCompletion: false })), /Other settings/);
});

test("r54 ASK 1: naive keeps the author's closeOpenTradesAtTestCompletion (a test-end rule, not a lever)", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const multiDay = (extra) => {
    const s = settings(extra);
    for (const l of s.parameters.legs) l.daysToExpiration = 7;
    return s;
  };
  const naiveOf = (s) => {
    const out = runRequest(s, sc, "X");
    return settingsFiles(s.parameters, out.runs).naive;
  };
  assert.equal(naiveOf(multiDay({ closeOpenTradesAtTestCompletion: true })).closeOpenTradesAtTestCompletion, true);
  assert.equal(naiveOf(multiDay({ closeOpenTradesAtTestCompletion: false })).closeOpenTradesAtTestCompletion, false);
  assert.equal("closeOpenTradesAtTestCompletion" in naiveOf(multiDay()), false);
  // Still shown to the user as what it is.
  assert.match(strategyAsBuilt(multiDay({ closeOpenTradesAtTestCompletion: true }).parameters), /^- Other settings: [^\n]*closeOpenTradesAtTestCompletion true/m);
});

test("r54 ASK 2 (Review A r53 F1): strategy-as-built shows every set field that changes trades", () => {
  const leg = (id, type, buySell, extra = {}) => ({ id, type, buySell, quantity: 1, daysToExpiration: 0, metricType: "Delta", delta: 10, ...extra });
  const p = (top = {}, group = {}) => ({
    underlying: "SPX", rangeStart: "2025-03-03", rangeEnd: "2025-03-14", startingFunds: 500000, entryTime: "10:07:00",
    legs: [leg("sp", "Put", "Sell"), leg("lp", "Put", "Buy", { metricType: "ChildLeg", childMetricType: "ParentOffset", parentId: "sp", parentStrikeOffset: -50, isExactOffset: true })],
    exitConditions: [{ legIds: [], maxLoss: 100, lossType: "Percentage", profitType: "Percentage", ...group }], ...top,
  });
  // ORB on: its direction and range end are part of the filter; off: not shown (no effect).
  const orb = strategyAsBuilt(p({ useOpeningRangeBreakout: true, breakoutCondition: "HighOnly", openingRangeBreakoutEndTime: "10:30" }));
  assert.match(orb, /^- Filters: useOpeningRangeBreakout true, breakoutCondition "HighOnly", openingRangeBreakoutEndTime "10:30"$/m);
  assert.doesNotMatch(strategyAsBuilt(p({ useOpeningRangeBreakout: false, breakoutCondition: "HighOnly", openingRangeBreakoutEndTime: "10:30" })), /breakoutCondition|openingRangeBreakoutEndTime/);
  // A set strike rounding and an exact offset choose the strikes.
  const legs = strategyAsBuilt(p({ roundStrikesToNearest: 25 })).split("## Entry")[0];
  assert.match(legs, /^- Strikes rounded to the nearest 25$/m);
  assert.match(legs, /^- B P 1 · 50 below S P, exact offset · 0 DTE$/m);
  assert.doesNotMatch(strategyAsBuilt(p()), /rounded|roundStrikesToNearest/);
  // r55 ASK 3: 0 is no rounding step (OO's 0 = off, as for maxContractsPerTrade and capitalPerContract).
  assert.doesNotMatch(strategyAsBuilt(p({ roundStrikesToNearest: 0 })), /rounded|roundStrikesToNearest/);
  // A per-leg stop watches named legs; actions show what they do, not only how many there are.
  const exit = (group) => strategyAsBuilt(p({}, group)).split("\n").find((l) => l.startsWith("- All legs"));
  assert.match(exit({ isMaxLossPerLeg: true, maxLossLegs: ["sp"] }), /stop loss 100%, per leg \(S P\);/);
  assert.doesNotMatch(exit({ isMaxLossPerLeg: false, maxLossLegs: ["sp"] }), /per leg|maxLossLegs/);
  // Switched-on actions and every other set exit field (a move exit with its unit field) as key value; a switched-off action is not shown.
  assert.match(exit({ useProfitActions: true, profitActions: [{ profitTarget: 50, profitAllocationPercentage: 50, stopLoss: 0 }] }),
    /; profitActions \[\{"profitTarget":50,"profitAllocationPercentage":50,"stopLoss":0\}\]$/);
  assert.match(exit({ useTimeActions: true, timeActions: [{ dte: 0, time: "12:00:00", stopLoss: 50 }] }), /; timeActions \[\{"dte":0,"time":"12:00:00","stopLoss":50\}\]$/);
  assert.doesNotMatch(exit({ useTimeActions: false, timeActions: [{ dte: 0, stopLoss: 50 }] }), /timeActions/);
  assert.match(exit({ exitUnderlyingPriceMoveUp: 20, exitUnderlyingPriceMoveType: "Points" }), /; exitUnderlyingPriceMoveUp 20, exitUnderlyingPriceMoveType "Points"$/);
});

test("r55 ASK 1 (Review A r54 F1): a saved backtest with no source description marks no core field assumed; with one, a core n/a is marked", () => {
  const p = { underlying: "SPX", rangeStart: "2025-03-03", rangeEnd: "2025-03-14", startingFunds: 1, entryTime: "10:00:00",
    legs: [{ id: "a", type: "Put", buySell: "Sell", daysToExpiration: 0, metricType: "Delta", delta: 10 }], exitConditions: [] };
  const allNa = Object.fromEntries([...C1.coreFields, ...C1.secondaryFields].map((f) => [f, { value: null, status: "n/a" }]));
  for (const source of [undefined, null, { ref: "x", built_from: "saved backtest" }, { ref: "x", built_from: "saved backtest", description: " " }])
    assert.doesNotMatch(strategyAsBuilt(p, allNa, {}, source), /assumed/, JSON.stringify(source));
  const described = strategyAsBuilt(p, allNa, {}, { ref: "x", built_from: "saved backtest", description: "Sell a 10 delta put." });
  assert.match(described, /^## Exit \*\(assumed: stop, exit\)\*$/m);
  assert.match(described, /starting funds \$1 \*\(assumed: underlying, date_range\)\*$/m);
  // main() passes the saved source: no description → the written file marks nothing.
  const { folder, s: settingsPath, run } = folderRun();
  writeFileSync(join(folder, "rule-sheet.json"), JSON.stringify({ source: { ref: "x", built_from: "saved backtest" }, rule_sheet: allNa }));
  run(["--settings", settingsPath, "--author-label", "X", "--run-folder", folder]);
  assert.doesNotMatch(readFileSync(join(folder, "strategy-as-built.md"), "utf8"), /assumed/);
});

// --- A14: pre-run gate for descriptions ("No guessing") ---------

const TOM = "I enter six trades each day at about 30 to 60 minutes apart, generally in the late morning through the afternoon. I sell a put spread and a call spread on SPX, zero DTE, for about one dollar to $1.75 credit on each side, usually 50 to 60 points wide, sometimes up to 100 wide. I set a stop for a 1x net loss, which is two times the initial credit, on each side separately. I leave all trades on until they either hit the stop or expire worthless. My backtest in Option Omega ran from January 2023 through September 5th, 2025.";
const said = (quote) => ({ status: "stated", quote });
const vague = (quote) => ({ status: "assumed", quote });
function tomSheet() {
  return {
    source: { ref: "uncle Tom", built_from: "description", description: TOM },
    rule_sheet: {
      underlying: { value: "SPX", ...said("on SPX") },
      structure: { value: "put credit spread + call credit spread", ...said("I sell a put spread and a call spread") },
      legs: { value: null, ...vague("for about one dollar to $1.75 credit on each side, usually 50 to 60 points wide, sometimes up to 100 wide") },
      dte: { value: 0, ...said("zero DTE") },
      entry_time: { value: null, ...vague("six trades each day at about 30 to 60 minutes apart, generally in the late morning through the afternoon") },
      days_traded: { value: "every trading day", ...said("each day") },
      stop: { value: "maxLoss 100 Percentage per side", ...said("a 1x net loss, which is two times the initial credit, on each side separately") },
      exit: { value: "hold to stop or expiry", ...said("until they either hit the stop or expire worthless") },
      date_range: { value: "2023-01-01 to 2025-09-05", ...said("from January 2023 through September 5th, 2025") },
      stop_mode: { value: "intra-minute", status: "assumed" },
      entry_filters: { value: "none", status: "assumed" },
      reentry: { value: "none", status: "assumed" },
      sizing: { value: "1 contract", status: "assumed" },
      fills: { value: "not stated", status: "assumed" },
    },
    variants_tried: 1,
  };
}
const ANSWER = "credit 1.50 on each side, width 55, entries 11:00, 11:45, 12:30, 13:15, 14:00, 14:45";
function answered() {
  const s = tomSheet();
  s.source.description += `\nUser (2026-11-24): ${ANSWER}`;
  s.rule_sheet.legs = { value: "spread premium 1.50, width 55", ...said("credit 1.50 on each side, width 55") };
  s.rule_sheet.entry_time = { value: "11:00 + 5 more every 45 min", ...said("entries 11:00, 11:45, 12:30, 13:15, 14:00, 14:45") };
  return s;
}
function tomSettings() {
  const leg = (id, type, buySell, extra) => ({ id, type, buySell, quantity: 1, daysToExpiration: 0, ...extra });
  const child = (parentId, off) => ({ metricType: "ChildLeg", childMetricType: "ParentOffset", parentId, parentStrikeOffset: off });
  const group = (id, legIds) => ({ id, name: id, legIds, maxLoss: 100, lossType: "Percentage" });
  return {
    underlying: "SPX", rangeStart: "2023-01-01", rangeEnd: "2025-09-05", startingFunds: 500000, useExactDte: true,
    entryTime: "11:00:00", additionalEntryTimes: ["11:45:00", "12:30:00", "13:15:00", "14:00:00", "14:45:00"],
    legs: [
      leg("sp", "Put", "Sell", { metricType: "SpreadPremium", spreadPremium: 1.5 }), leg("lp", "Put", "Buy", child("sp", -55)),
      leg("sc", "Call", "Sell", { metricType: "SpreadPremium", spreadPremium: 1.5 }), leg("lc", "Call", "Buy", child("sc", 55)),
    ],
    exitConditions: [group("put", ["sp", "lp"]), group("call", ["sc", "lc"])],
    maxContractsPerTrade: 1, allocationPercentage: 0, ignoreMarginRequirements: true,
  };
}
function gateRun(sheet) {
  const { dir, configPath } = setup();
  const folder = join(dir, "run");
  mkdirSync(folder);
  writeFileSync(join(folder, "rule-sheet.json"), JSON.stringify(sheet));
  const s = join(dir, "source.settings.json");
  writeFileSync(s, JSON.stringify(tomSettings()));
  const run = (argv) => main([...argv, "--author-label", "Tom", "--run-folder", folder], { HOME: dir, TRIAGE_CONFIG: configPath });
  return { folder, s, run };
}
const C1 = JSON.parse(readFileSync(join(SKILL, "thresholds.json"), "utf8")).checks.C1;

test("A14: a description with assumed core fields stops with NOT_BUILDABLE before any file is written; --settings is not needed", () => {
  const { folder, run } = gateRun(tomSheet());
  let message = "";
  assert.throws(() => run([]), (e) => ((message = e.message), /^NOT_BUILDABLE: /.test(e.message)));
  const lines = message.replace(/^NOT_BUILDABLE: /, "").split("\n");
  // The fixed text, shown word for word: the stop, the core fields not stated, one line per missing core field, nothing run.
  // No C (it read like "61 % sure" although the defaults are safe).
  assert.equal(lines[0], "Cannot build the author's strategy with confidence from this description.");
  assert.equal(lines[1], "Core fields not stated: legs, entry_time.");
  assert.doesNotMatch(message, /C = |[Cc]onfidence C|score/);
  assert.equal(lines[2], "Please supply:");
  assert.equal(lines[3], `- legs: ${C1.ask.legs} Source says: "${tomSheet().rule_sheet.legs.quote}"`);
  assert.equal(lines[4], `- entry_time: ${C1.ask.entry_time} Source says: "${tomSheet().rule_sheet.entry_time.quote}"`);
  assert.equal(lines.at(-1), "No Option Omega backtest was run.");
  assert.equal(lines.length, 6, "defaults (stop_mode, fills, sizing, ...) never stop the build");
  assert.deepEqual(readdirSync(folder), ["rule-sheet.json"], "nothing written");
  // A core field missing from the sheet is not stated either.
  const noDays = tomSheet();
  delete noDays.rule_sheet.days_traded;
  assert.throws(() => gateRun(noDays).run([]), /^Error: NOT_BUILDABLE: [^]*\n- days_traded: /);
});

test("A14: with the user's answers appended and stated, the settings are written and strategy-as-built.md marks each default as built (no count line, no defaults line, no C)", () => {
  const { folder, s, run } = gateRun(answered());
  // The gate passes first; only then are the settings required.
  assert.throws(() => run([]), /^Error: USAGE: .*--settings/);
  const out = run(["--settings", s]);
  assert.ok(out.runs.length >= 4);
  for (const r of out.runs) assert.ok(existsSync(join(folder, `${r.role}.settings.json`)), r.role);
  // Each assumed default is marked where it is built; nothing else is added.
  const md = readFileSync(join(folder, "strategy-as-built.md"), "utf8");
  assert.equal(md, strategyAsBuilt(JSON.parse(readFileSync(join(folder, "author.settings.json"), "utf8")), answered().rule_sheet, out, answered().source));
  for (const line of [/^- Allocation: .*\*\(assumed: sizing\)\*$/m, /^- Filters: none \*\(assumed: entry_filters\)\*$/m, /^- Re-entry: none \*\(assumed: reentry\)\*$/m,
    /^## Exit \*\(assumed: stop_mode\)\*$/m, /^## Misc \*\(assumed: fills\)\*$/m]) assert.match(md, line);
  assert.doesNotMatch(md, /Every core field stated|Defaults used|C = |[Cc]onfidence/);
  assert.equal("defaultsUsed" in out, false);
});

// Settings as from-description rule 2 leaves them: no value for a missing core field (no strike values, no entry time).
function ruleTwoSettings() {
  const p = tomSettings();
  for (const l of p.legs) { delete l.spreadPremium; delete l.parentStrikeOffset; }
  delete p.entryTime;
  delete p.additionalEntryTimes;
  return p;
}
const ASK_RERUN = "write the user's answers into source.settings.json, then rerun step 3";

test("A14 / B2: answers stated but settings left as rule 2 wrote them → BAD_SETTINGS naming each gap, nothing written", () => {
  const { folder, s, run } = gateRun(answered());
  writeFileSync(s, JSON.stringify(ruleTwoSettings()));
  let message = "";
  assert.throws(() => run(["--settings", s]), (e) => ((message = e.message), /^BAD_SETTINGS: /.test(e.message)));
  for (const gap of ["sp: no numeric spreadPremium", "lp: no numeric parentStrikeOffset", "sc: no numeric spreadPremium", "lc: no numeric parentStrikeOffset", "no entryTime and no floating entry window"])
    assert.ok(message.includes(gap), gap);
  assert.ok(message.endsWith(ASK_RERUN), message);
  assert.deepEqual(readdirSync(folder), ["rule-sheet.json"], "nothing written");
});

test("B2: settingsGaps names each gap type once; a saved backtest's full settings pass", () => {
  const gaps = (edit) => { const p = tomSettings(); edit(p); return rr.settingsGaps(p); };
  assert.deepEqual(rr.settingsGaps(tomSettings()), []);
  assert.deepEqual(rr.settingsGaps({ parameters: tomSettings() }), []);
  assert.deepEqual(gaps((p) => delete p.legs[0].spreadPremium), ["leg sp: no numeric spreadPremium for metricType SpreadPremium"]);
  assert.deepEqual(gaps((p) => (p.legs[0] = { ...p.legs[0], metricType: "Delta", delta: "16" })), ["leg sp: no numeric delta for metricType Delta"]);
  assert.deepEqual(gaps((p) => delete p.legs[0].metricType), ["leg sp: metricType missing or unknown (null)"]);
  assert.deepEqual(gaps((p) => (p.legs[0].metricType = "Midpoint")), ['leg sp: metricType missing or unknown ("Midpoint")']);
  assert.deepEqual(gaps((p) => delete p.legs[1].parentStrikeOffset), ["leg lp: no numeric parentStrikeOffset for childMetricType ParentOffset"]);
  assert.deepEqual(gaps((p) => delete p.legs[1].childMetricType), ["leg lp: childMetricType missing or unknown (null)"]);
  assert.deepEqual(gaps((p) => (p.legs[1].parentId = "zz")), ['leg lp: parentId "zz" is not a leg']);
  assert.deepEqual(gaps((p) => delete p.legs[2].daysToExpiration), ["leg sc: no numeric daysToExpiration"]);
  const noTime = ["no entryTime and no floating entry window (useFloatingEntryTime with minEntryTime and maxEntryTime)"];
  assert.deepEqual(gaps((p) => delete p.entryTime), noTime);
  assert.deepEqual(gaps((p) => { delete p.entryTime; Object.assign(p, { useFloatingEntryTime: true, minEntryTime: "10:00:00" }); }), noTime);
  assert.deepEqual(gaps((p) => { delete p.entryTime; Object.assign(p, { useFloatingEntryTime: true, minEntryTime: "10:00:00", maxEntryTime: "11:00:00" }); }), []);
  // Every source: a saved backtest with gaps is refused too.
  const saved = tomSheet();
  saved.source.built_from = "saved backtest";
  const sv = gateRun(saved);
  writeFileSync(sv.s, JSON.stringify(ruleTwoSettings()));
  assert.throws(() => sv.run(["--settings", sv.s]), /^Error: BAD_SETTINGS: /);
  assert.deepEqual(readdirSync(sv.folder), ["rule-sheet.json"]);
});

test("N1: answered sheet with legs [] or a non-array → BAD_SETTINGS \"no legs\" (no TypeError), nothing written", () => {
  for (const legs of [[], {}, undefined]) {
    const { folder, s, run } = gateRun(answered());
    const p = tomSettings();
    if (legs === undefined) delete p.legs; else p.legs = legs;
    writeFileSync(s, JSON.stringify(p));
    let message = "";
    assert.throws(() => run(["--settings", s]), (e) => ((message = e.message), /^BAD_SETTINGS: no legs; /.test(e.message)), JSON.stringify(legs));
    assert.ok(message.endsWith(ASK_RERUN), message);
    assert.deepEqual(readdirSync(folder), ["rule-sheet.json"], "nothing written");
  }
  assert.deepEqual(rr.settingsGaps({ ...tomSettings(), legs: "sp" }).slice(0, 1), ["no legs"]);
});

test("A14 / B1: a core field marked n/a is not stated → NOT_BUILDABLE naming it", () => {
  const s = answered();
  s.rule_sheet.legs = { value: null, status: "n/a" };
  s.rule_sheet.entry_time = { value: null, status: "n/a" };
  const g = gateRun(s);
  assert.throws(() => g.run(["--settings", g.s]), /^Error: NOT_BUILDABLE: [^]*Core fields not stated: legs, entry_time\.\n[^]*- legs: [^]*- entry_time: /);
  assert.deepEqual(readdirSync(g.folder), ["rule-sheet.json"]);
});

test("A14 / D2: built_from description needs source.description as text, not only a sha256", () => {
  const msg = /^Error: BAD_RULE_SHEET: built_from description needs source.description as text; a sha256 cannot be checked against a quote$/;
  const sha = answered();
  delete sha.source.description;
  sha.source.descriptionSha256 = "a".repeat(64);
  assert.throws(() => gateRun(sha).run([]), msg);
  const none = answered();
  none.source.description = "  ";
  assert.throws(() => gateRun(none).run([]), msg);
});

test("A14: a stated core field needs a quote that appears literally in the description, else BAD_RULE_SHEET naming it", () => {
  const wrong = answered();
  wrong.rule_sheet.legs.quote = "credit 1.40 on each side, width 55";
  const g = gateRun(wrong);
  assert.throws(() => g.run(["--settings", g.s]), /^Error: BAD_RULE_SHEET: .*\blegs\b.*quote/);
  assert.deepEqual(readdirSync(g.folder), ["rule-sheet.json"]);
  const none = answered();
  delete none.rule_sheet.dte.quote;
  assert.throws(() => gateRun(none).run([]), /^Error: BAD_RULE_SHEET: .*\bdte\b.*quote/);
  // A description without built_from is refused: the gate must know whether the settings came from it.
  const unknown = answered();
  delete unknown.source.built_from;
  assert.throws(() => gateRun(unknown).run([]), /^Error: BAD_RULE_SHEET: .*built_from/);
  // A saved backtest with a description beside it: no gate (C1 stays the post-run cap, A4).
  const saved = tomSheet();
  saved.source.built_from = "saved backtest";
  const sv = gateRun(saved);
  assert.doesNotThrow(() => sv.run(["--settings", sv.s]));
  assert.doesNotMatch(readFileSync(join(sv.folder, "strategy-as-built.md"), "utf8"), /Translation confidence|Every core field stated|Defaults used/);
});

test("A14: thresholds.json C1 has one ask line per core field, no score threshold, no weights", () => {
  assert.deepEqual(Object.keys(C1.ask), C1.coreFields);
  assert.deepEqual(C1.rules.map((r) => r.metric), ["assumedCoreFields"]);
  assert.equal("weights" in C1, false);
});

test("blind-run item 6: author_base's why names an unknown author cost as not stated, never null", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const p = settings().parameters;
  delete p.closingFees;
  const why = runRequest({ parameters: p }, sc, "X").runs.find((r) => r.role === "author_base").why;
  assert.match(why, /closingFees not stated/);
  assert.match(why, /openingFees 0\.6/);
  assert.doesNotMatch(why, /null/);
});

test("r56 ASK 1: naive keeps the author's ignoreWideBidAskTrades (a quote-quality rule, not a market filter); strategy-as-built shows it under Misc, not as a filter", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const naiveOf = (s) => settingsFiles(s.parameters, runRequest(s, sc, "X").runs).naive;
  assert.equal(naiveOf(settings({ ignoreWideBidAskTrades: true })).ignoreWideBidAskTrades, true);
  assert.equal(naiveOf(settings({ ignoreWideBidAskTrades: false })).ignoreWideBidAskTrades, false);
  assert.equal("ignoreWideBidAskTrades" in naiveOf(settings()), false);
  const shown = strategyAsBuilt(settings({ ignoreWideBidAskTrades: true, entryMinVix: null, useOpeningRangeBreakout: false }).parameters);
  assert.match(shown, /^- Filters: none$/m);
  assert.match(shown.split("## Misc")[1], /^- Quote quality: ignoreWideBidAskTrades true \(kept in every run\)$/m);
  assert.doesNotMatch(shown, /Other settings/);
  assert.doesNotMatch(strategyAsBuilt(settings({ ignoreWideBidAskTrades: false }).parameters), /Quote quality/);
});

// The blackout list of a real saved backtest (16 FOMC days); without blackout days Option Omega leaves the field out (null).
const BLACKOUT = "2023-02-01,2023-03-22,2023-05-03,2023-06-14,2023-07-26,2023-09-20,2023-11-01,2023-12-13,2024-01-31,2024-03-20,2024-05-01,2024-06-12,2024-07-31,2024-09-18,2024-11-07,2024-12-18";
test("r56 ASK 2: a set blackoutDays list no longer ends in REVIEW_BY_HAND; naive empties it (null), the author run keeps it, strategy-as-built shows it", () => {
  const { folder, s, run } = folderRun({ blackoutDays: BLACKOUT });
  const out = run(["--settings", s, "--author-label", "X", "--run-folder", folder]);
  const naive = out.runs.find((r) => r.role === "naive");
  assert.deepEqual(naive.reviewByHand, []);
  assert.equal(naive.set.blackoutDays, null);
  const read = (role) => JSON.parse(readFileSync(join(folder, `${role}.settings.json`), "utf8"));
  assert.equal(read("naive").blackoutDays, null);
  for (const role of out.runs.map((r) => r.role).filter((r) => r !== "naive")) assert.equal(read(role).blackoutDays, BLACKOUT, role);
  assert.match(readFileSync(join(folder, "strategy-as-built.md"), "utf8"), /^- Days: every trading day, except 16 blackout days$/m);
  assert.match(naive.why, /blackout days/);
  // Already empty: nothing to change.
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  assert.equal("blackoutDays" in runRequest(settings({ blackoutDays: null }), sc, "X").runs.find((r) => r.role === "naive").set, false);
});

test("r56 ASK 2: C3's missing rule days come from the run the script names: naive when the author skips rule days on purpose (entry filters or blackout days), else the author", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const from = (o) => runRequest(settings({ entryMinVix: null, useOpeningRangeBreakout: false, ...COSTS.scenarios.base, ...o }), sc, "X").c3MissingDaysRun;
  assert.equal(from({}), "author");
  assert.equal(from({ blackoutDays: BLACKOUT }), "naive");
  assert.equal(from({ entryMaxVix: 30 }), "naive");
  // Kept in naive too, so both runs skip the same days: no reason to switch.
  assert.equal(from({ ignoreWideBidAskTrades: true }), "author");
  assert.equal(from({ blackoutDays: null }), "author");
});

// --- round 58: blind run r57 findings ---------------------------------------

test("r58 point 6, reverted in r59 ASK 4: C3 reads the author run itself (a calendar check, independent of costs), or naive with entry filters or blackout days", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const from = (o) => runRequest(settings({ entryMinVix: null, useOpeningRangeBreakout: false, ...o }), sc, "X").c3MissingDaysRun;
  // settings() has costs off the base → author_base runs; C3 still reads the author run (PRD C3 row).
  assert.equal(from({}), "author");
  assert.equal(from({ ...COSTS.scenarios.base }), "author");
  assert.equal(from({ blackoutDays: BLACKOUT }), "naive");
});

test("r58 point 7 / r59 ASK 3 / r63 #4: starting funds - above 0 for every source; a description build uses 500000, marked assumed, unless a stated sizing quote found in the description names the amount", () => {
  assert.ok(rr.settingsGaps({ ...tomSettings(), startingFunds: 0 }).some((g) => /startingFunds/.test(g)));
  assert.ok(rr.settingsGaps({ ...tomSettings(), startingFunds: undefined }).some((g) => /startingFunds/.test(g)));
  const built = (st, funds) => {
    const g = gateRun(st);
    writeFileSync(g.s, JSON.stringify({ ...tomSettings(), startingFunds: funds }));
    g.run(["--settings", g.s]);
    const read = (f) => readFileSync(join(g.folder, f), "utf8");
    return { funds: JSON.parse(read("author.settings.json")).startingFunds, naive: JSON.parse(read("naive.settings.json")).startingFunds, md: read("strategy-as-built.md"), rr: JSON.parse(read("run-request.json")) };
  };
  const withSizing = (line, quote) => {
    const st = answered();
    st.source.description += `\nUser (2026-11-27): ${line}`;
    st.rule_sheet.sizing = { value: "1 contract per entry", ...said(quote) };
    return st;
  };
  // Not stated (sizing assumed, sizing stated as a count only, a quote not in the description, or left out): every run gets the default, marked assumed; nothing is refused.
  for (const [st, funds] of [[answered(), 100000], [withSizing("1 contract per entry", "1 contract per entry"), 100000],
    [withSizing("1 contract per entry", "1 contract per entry on a $100,000 account"), 100000], [answered(), undefined]]) {
    const b = built(st, funds);
    assert.equal(b.funds, 500000);
    assert.equal(b.naive, 500000);
    assert.equal(b.rr.returnBasis.startingFundsAssumed, true);
    assert.match(b.md, /starting funds \$500000 \*\(assumed: [^)]*starting funds\)\*$/m);
  }
  // The amount named in a stated sizing quote ("$100,000", "100k") stands, unmarked.
  for (const q of ["1 contract per entry on a $100,000 account", "1 contract per entry, 100k account"]) {
    const b = built(withSizing(q, q), 100000);
    assert.equal(b.funds, 100000);
    assert.equal(b.rr.returnBasis.startingFundsAssumed, false);
    assert.match(b.md, /starting funds \$100000$/m, q);
  }
});

test("r58 point 8: a SpreadPremium leg gets one line in strategy-as-built.md on what Option Omega targets", () => {
  const { folder, s, run } = gateRun(answered());
  writeFileSync(s, JSON.stringify({ ...tomSettings(), startingFunds: 500000 }));
  run(["--settings", s]);
  const md = readFileSync(join(folder, "strategy-as-built.md"), "utf8");
  assert.match(md, /^- Spread premium: Option Omega targets the whole spread's net credit \(short minus long leg\) with it, not the short leg's own price; filled credits vary around that target\.$/m);
  const p = { underlying: "SPX", rangeStart: "2025-03-03", rangeEnd: "2025-03-14", startingFunds: 1, entryTime: "10:00:00",
    legs: [{ id: "a", type: "Put", buySell: "Sell", daysToExpiration: 0, metricType: "Delta", delta: 10 }], exitConditions: [] };
  assert.doesNotMatch(strategyAsBuilt(p, {}, {}), /Spread premium:/);
});

test("r63 ASK 2 F3: the run request records whether the starting funds are the assumed default (description build, sizing stated or not); a saved backtest's own value is not assumed", () => {
  const st = answered();
  st.source.description += "\nUser (2026-11-27): 1 contract per entry";
  st.rule_sheet.sizing = { value: "1 contract per entry", ...said("1 contract per entry") };
  const g = gateRun(st);
  writeFileSync(g.s, JSON.stringify({ ...tomSettings(), startingFunds: 500000 }));
  g.run(["--settings", g.s]);
  assert.equal(JSON.parse(readFileSync(join(g.folder, "run-request.json"), "utf8")).returnBasis.startingFundsAssumed, true);
  const { dir, configPath } = setup();
  const folder = join(dir, "run");
  mkdirSync(folder);
  writeFileSync(join(folder, "rule-sheet.json"), savedSheet());
  const s = join(dir, "s.json");
  writeFileSync(s, JSON.stringify(settings({ startingFunds: 100000 })));
  main(["--settings", s, "--author-label", "A", "--run-folder", folder], { TRIAGE_CONFIG: configPath });
  assert.equal(JSON.parse(readFileSync(join(folder, "run-request.json"), "utf8")).returnBasis.startingFundsAssumed, false);
});

// --- round 64 -----------------------------------------------------------------

test("r64 ASK 1 (#9): a saved backtest without a description - the script writes rule-sheet.json from the settings, 14 fields, all n/a", () => {
  const { folder, s, run } = folderRun({ weeklyEntries: ["Monday", "Thursday"], maxContractsPerTrade: 1, ignoreMarginRequirements: true });
  rmSync(join(folder, "rule-sheet.json"));
  run(["--settings", s, "--author-label", "X", "--run-folder", folder, "--saved-backtest", "PCS 10d"]);
  const sheet = JSON.parse(readFileSync(join(folder, "rule-sheet.json"), "utf8"));
  assert.deepEqual(sheet.source, { ref: "PCS 10d", built_from: "saved backtest" });
  assert.deepEqual(Object.keys(sheet.rule_sheet).sort(), [...C1.coreFields, ...C1.secondaryFields].sort());
  for (const [f, e] of Object.entries(sheet.rule_sheet)) assert.equal(e.status, "n/a", f);
  const r = sheet.rule_sheet;
  assert.equal(r.underlying.value, "SPX");
  assert.equal(r.date_range.value, "2022-01-03 to 2025-12-31");
  assert.equal(r.days_traded.value, "Monday, Thursday");
  assert.equal(r.entry_time.value, "10:00");
  assert.match(r.legs.value, /S P 1 · 10Δ · 0 DTE; B P 1 · 5Δ · 0 DTE/);
  assert.match(r.stop.value, /stop loss 200/);
  assert.match(r.exit.value, /profit target 50/);
  assert.equal(r.stop_mode.value, "intra-minute");
  // Same text as strategy-as-built (one mapping): the legs line appears there too.
  assert.match(readFileSync(join(folder, "strategy-as-built.md"), "utf8"), /^- S P 1 · 10Δ · 0 DTE$/m);
  // A sheet with a source description is the agent's (step 2): never overwritten.
  writeFileSync(join(folder, "rule-sheet.json"), JSON.stringify(answered()));
  assert.throws(() => run(["--settings", s, "--author-label", "X", "--run-folder", folder, "--saved-backtest", "PCS 10d"]), /^Error: BAD_RULE_SHEET: .*description/);
  // Without the flag a missing sheet still stops, naming both ways on.
  rmSync(join(folder, "rule-sheet.json"));
  assert.throws(() => run(["--settings", s, "--author-label", "X", "--run-folder", folder]), /BAD_RULE_SHEET: .*--saved-backtest/);
});

test("r64 ASK 2 (#1): a set top-level move or gap filter shows its unit field; unset filters stay hidden", () => {
  const p = (top) => ({ ...settings({ entryMinVix: null, useOpeningRangeBreakout: false, reentryConditions: [], ...top }).parameters });
  assert.match(strategyAsBuilt(p({ entryMaxMoveUp: 0.5, entryMoveType: "Percentage" })), /^- Filters: entryMaxMoveUp 0\.5 \(entryMoveType "Percentage"\)$/m);
  assert.match(strategyAsBuilt(p({ entryMinGapDown: 10, entryGapType: "Points" })), /^- Filters: entryMinGapDown 10 \(entryGapType "Points"\)$/m);
  assert.match(strategyAsBuilt(p({ entryVixMaxMoveUp: 5, entryVixMoveType: "Percentage" })), /entryVixMaxMoveUp 5 \(entryVixMoveType "Percentage"\)/);
  assert.match(strategyAsBuilt(p({ entryMaxMoveUp: 0.5 })), /entryMaxMoveUp 0\.5 \(entryMoveType not stated\)/);
  const none = strategyAsBuilt(p({ entryMaxMoveUp: null, entryMoveType: "Percentage" }));
  assert.match(none, /^- Filters: none$/m);
  assert.doesNotMatch(none, /entryMoveType/);
});

test("r64 ASK 3a (blind public #4): run-request.json carries the get_rule_calendar arguments as c3Rule; Mondays and Thursdays are [1, 4]", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const c3 = (over) => runRequest(settings(over), sc, "X").c3Rule;
  assert.deepEqual(c3({ weeklyEntries: ["Monday", "Thursday"], useExactDte: true }), {
    rule: { entryWeekdays: [1, 4], dte: 0, selection: "exact", entryWindow: { from: "10:00", to: "10:00" } },
    dateRange: { start: "2022-01-03", end: "2025-12-31" },
    recordEnd: "2025-12-31",
  });
  const every = c3({ weeklyEntries: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], additionalEntryTimes: ["14:30:00", "11:15:00"] });
  assert.equal(every.rule.entryWeekdays, "daily");
  assert.equal(every.rule.selection, "firstAtLeast");
  assert.deepEqual(every.rule.entryWindow, { from: "10:00", to: "14:30" });
  assert.equal(c3({}).rule.entryWeekdays, "daily");
  // Floating window; the front leg's DTE for a calendar.
  const fl = c3({ useFloatingEntryTime: true, minEntryTime: "09:45", maxEntryTime: "15:15", entryTime: null,
    legs: [{ type: "Call", buySell: "Sell", daysToExpiration: 7, metricType: "Delta", delta: 30 }, { type: "Call", buySell: "Buy", daysToExpiration: 14, metricType: "Delta", delta: 30 }] });
  assert.deepEqual(fl.rule.entryWindow, { from: "09:45", to: "15:15" });
  assert.equal(fl.rule.dte, 7);
  // A day rule the tool cannot take: no rule object, the reason named (C3 not run).
  const monthly = runRequest(settings({ weeklyEntries: [], monthlyEntryDay: "Friday", monthlyEntryOrdinal: 3 }), sc, "X");
  assert.equal(monthly.c3Rule, null);
  assert.match(monthly.c3RuleNotRun, /monthly/);
});

test("r64 ASK 3b: run-request.json carries the finished C8 query on the realistic run; no later start, no query", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const out = runRequest(settings(), sc, "X");
  assert.deepEqual(out.c8Starts, ["2022-07-03", "2023-01-03", "2023-07-03"]);
  assert.equal(out.c8Sql,
    "SELECT strftime(s.d, '%Y-%m-%d') AS \"startDate\", COALESCE(SUM(t.pl), 0) AS \"netPl\" FROM (VALUES (DATE '2022-07-03'), (DATE '2023-01-03'), (DATE '2023-07-03')) s(d) " +
    "LEFT JOIN trades.trade_data t ON t.block_id = '<block_id>' AND t.strategy = 'X base-costs' AND t.date_opened >= s.d GROUP BY s.d ORDER BY s.d");
  // Author on the base costs: the realistic run is the author run.
  assert.match(runRequest(settings({ ...COSTS.scenarios.base }), sc, "X").c8Sql, /t\.strategy = 'X' /);
  assert.equal(runRequest(settings({ rangeStart: "2024-01-02" }), sc, "X").c8Sql, null);
  // A quote in a label is doubled (SQL string literal).
  assert.match(runRequest(settings(), sc, "Tom's PCS").c8Sql, /t\.strategy = 'Tom''s PCS base-costs'/);
});

// --- r66 ASK 2: a saved backtest's own intra-minute setting is the author's stop mode ---
test("r66 ASK 2: saved backtest with intra-minute off keeps the author run off; every check run on; rule sheet, flag and stop neighbours follow", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const role = (out, r) => out.runs.find((x) => x.role === r);
  const saved = { ref: "PCS", built_from: "saved backtest" };
  const off = settings({ exitConditions: [{ maxLoss: 200, useIntraMinuteStop: false }] });
  const sheet = rr.savedRuleSheet(off.parameters, "PCS");
  // B r65 #4: the sheet shows the saved value as the author's.
  assert.equal(sheet.rule_sheet.stop_mode.value, "minute");
  // Author on base costs: the author run is the realistic run; no change to its stops.
  const out = runRequest(off, sc, "X", sheet.rule_sheet, saved);
  assert.equal(out.flags.author_without_intra_minute, true);
  assert.equal(role(out, "author").exitConditions, undefined);
  assert.match(role(out, "author").why, /saved backtest/);
  for (const r of ["author_base", "cost_2x"]) if (role(out, r)) assert.equal(role(out, r).exitConditions[0].useIntraMinuteStop, true, r);
  assert.equal("useIntraMinuteStop" in (role(out, "naive").exitConditions?.[0] ?? {}), false, "naive: no stop left");
  // Off the base costs: author_base (the realistic run) and its stop neighbours on.
  const offBase = settings({ entrySlippage: 0.05, exitConditions: [{ maxLoss: 200, useIntraMinuteStop: false }] });
  const ob = runRequest(offBase, sc, "X", sheet.rule_sheet, saved);
  assert.equal(role(ob, "author").exitConditions, undefined);
  for (const r of ["author_base", "cost_2x", "stop_tight", "stop_wide"]) assert.equal(role(ob, r).exitConditions[0].useIntraMinuteStop, true, r);
  // Saved with intra-minute on: unchanged, no flag; a description build is unchanged (nothing stated: on).
  const on = runRequest(settings(), sc, "X", rr.savedRuleSheet(settings().parameters, "PCS").rule_sheet, saved);
  assert.equal(on.flags.author_without_intra_minute, false);
  assert.equal(rr.savedRuleSheet(settings().parameters, "PCS").rule_sheet.stop_mode.value, "intra-minute");
  const described = runRequest(off, sc, "X", {}, { ref: "x", built_from: "description", description: "d" });
  assert.deepEqual(role(described, "author").exitConditions, [{ useIntraMinuteStop: true }]);
  assert.equal(described.flags.author_without_intra_minute, false);
  // Two stop groups saved differently: the sheet names each group's mode; only the off group is kept off.
  const mixed = settings({ exitConditions: [{ name: "Put", maxLoss: 200, useIntraMinuteStop: true }, { name: "Call", maxLoss: 200, useIntraMinuteStop: false }] });
  assert.match(rr.savedRuleSheet(mixed.parameters, "PCS").rule_sheet.stop_mode.value, /intra-minute.*minute/);
});

// --- r67 ASK 1: the realistic run is always intra-minute ---
test("r67 ASK 1: author run without intra-minute on the base costs -> author_base runs with intra-minute, the stop neighbours mirror it; author intra-minute -> no author_base", () => {
  const { configPath } = setup();
  const sc = loadScenarios(readConfig(configPath));
  const role = (out, r) => out.runs.find((x) => x.role === r);
  const atBase = (g) => settings({ ...COSTS.scenarios.base, exitConditions: [{ maxLoss: 200, ...g }] });
  const check = (out, p) => {
    assert.equal(out.flags.author_costs_match_base, true);
    assert.equal(out.flags.author_without_intra_minute, true);
    assert.deepEqual(out.runs.map((r) => r.role), ["author", "author_base", "naive", "cost_2x", "stop_tight", "stop_wide"]);
    const ab = role(out, "author_base");
    assert.equal(ab.label, "X base-costs");
    assert.deepEqual(ab.set, {}, "costs already the base: nothing but the stop mode changes");
    assert.match(ab.why, /intra-minute/);
    assert.doesNotMatch(ab.why, /differ from the base scenario/);
    const files = settingsFiles(p.parameters, out.runs);
    for (const r of ["author_base", "stop_tight", "stop_wide", "cost_2x"]) assert.equal(files[r].exitConditions[0].useIntraMinuteStop, true, r);
    assert.equal(files.author.exitConditions[0].useIntraMinuteStop, false);
    assert.match(role(out, "stop_tight").why, /^author_base run/);
    assert.match(out.c8Sql, /t\.strategy = 'X base-costs'/);
  };
  // (a) a description stating minute stops.
  const a = atBase({ useIntraMinuteStop: true });
  check(runRequest(a, sc, "X", { stop_mode: { value: "minute", status: "stated" } }), a);
  // (b) a saved backtest with its stop group saved off.
  const b = atBase({ useIntraMinuteStop: false });
  check(runRequest(b, sc, "X", rr.savedRuleSheet(b.parameters, "PCS").rule_sheet, { ref: "PCS", built_from: "saved backtest" }), b);
  // (c) base costs, author intra-minute: no author_base (unchanged).
  const c = runRequest(a, sc, "X", {});
  assert.equal(c.flags.author_without_intra_minute, false);
  assert.deepEqual(c.runs.map((r) => r.role), ["author", "naive", "cost_2x", "stop_tight", "stop_wide"]);
  assert.match(c.c8Sql, /t\.strategy = 'X'/);
  // Off the base costs and minute: the why names both.
  const off = runRequest(settings({ exitConditions: [{ maxLoss: 200, useIntraMinuteStop: true }] }), sc, "X", { stop_mode: { value: "minute", status: "stated" } });
  assert.match(role(off, "author_base").why, /differ from the base scenario/);
});

// --- r68 ASK 1 (release review A) ---------------------------------------------

test("r68 F1: a stated stop_mode is exactly intra-minute or minute, with a quote found literally in the description, else BAD_RULE_SHEET naming both values", () => {
  const withMode = (mode) => { const st = answered(); st.rule_sheet.stop_mode = mode; return st; };
  const msg = /^Error: BAD_RULE_SHEET: stop_mode .*"intra-minute" or "minute"/;
  for (const value of ["Minute", "minute stops", "1-minute"]) {
    const st = withMode({ value, ...said("I set a stop") });
    const g = gateRun(st);
    assert.throws(() => g.run(["--settings", g.s]), msg, value);
    assert.deepEqual(readdirSync(g.folder), ["rule-sheet.json"], "nothing written");
  }
  // Exact value, but no quote or one not in the description.
  for (const quote of [undefined, "minute stops only"]) {
    const g = gateRun(withMode({ value: "minute", status: "stated", ...(quote ? { quote } : {}) }));
    assert.throws(() => g.run(["--settings", g.s]), msg, String(quote));
  }
  // Exact value with a literal quote: built, the author run on minute stops.
  const ok = gateRun(withMode({ value: "minute", ...said("I set a stop") }));
  assert.equal(ok.run(["--settings", ok.s]).flags.author_without_intra_minute, true);
  // Assumed stays free text (the default intra-minute is used).
  const assumed = gateRun(withMode({ value: "not stated", status: "assumed" }));
  assert.equal(assumed.run(["--settings", assumed.s]).flags.author_without_intra_minute, false);
});

test("r68 F4: a stated sizing quote naming an amount other than the settings' starting funds stops with BAD_SETTINGS naming both; nothing written", () => {
  const st = answered();
  st.source.description += "\nUser (2026-11-27): Account $50,000, 1 contract per entry.";
  st.rule_sheet.sizing = { value: "1 contract per entry", ...said("Account $50,000, 1 contract per entry.") };
  for (const funds of [100000, undefined]) {
    const g = gateRun(st);
    writeFileSync(g.s, JSON.stringify({ ...tomSettings(), startingFunds: funds }));
    let message = "";
    assert.throws(() => g.run(["--settings", g.s]), (e) => ((message = e.message), /^BAD_SETTINGS: /.test(e.message)), String(funds));
    assert.match(message, /50000/);
    assert.match(message, funds ? /100000/ : /not set/);
    assert.ok(message.endsWith(ASK_RERUN), message);
    assert.deepEqual(readdirSync(g.folder), ["rule-sheet.json"], "nothing written");
  }
  // The stated amount in the settings: built, not assumed; a contract count alone is no amount.
  const g = gateRun(st);
  writeFileSync(g.s, JSON.stringify({ ...tomSettings(), startingFunds: 50000 }));
  assert.equal(g.run(["--settings", g.s]).returnBasis.startingFundsAssumed, false);
});

// --- round 69: private blind run (SPX IC 0DTE, stop per side "when the loss reaches 2x the credit") ---

const stopRun = (quote, maxLoss, extra = {}) => {
  const st = answered();
  st.source.description += `\nUser (2026-11-27): ${quote}`;
  st.rule_sheet.stop = { value: `maxLoss ${maxLoss} Percentage per side`, ...said(quote) };
  const g = gateRun(st);
  const s = tomSettings();
  for (const e of s.exitConditions) e.maxLoss = maxLoss;
  writeFileSync(g.s, JSON.stringify({ ...s, ...extra }));
  return g;
};

test("r69 #2: a stated stop quote with one multiple maps to maxLoss by its wording (loss: N x 100, credit or price: (N-1) x 100), else BAD_SETTINGS naming both; a bare multiple is not stated", () => {
  const loss = "Stop on each side when the loss reaches 2x the credit received on that side";
  const price = "stop at 2x the credit received";
  for (const [quote, wrong, right] of [[loss, 100, 200], [price, 200, 100], ["stop when the spread price reaches 3x", 100, 200]]) {
    const bad = stopRun(quote, wrong);
    let message = "";
    assert.throws(() => bad.run(["--settings", bad.s]), (e) => ((message = e.message), /^BAD_SETTINGS: /.test(e.message)), quote);
    assert.match(message, new RegExp(`maxLoss ${wrong}\\b.*\\b${right}\\b`), message);
    assert.ok(message.endsWith(ASK_RERUN), message);
    assert.deepEqual(readdirSync(bad.folder), ["rule-sheet.json"], "nothing written");
    const ok = stopRun(quote, right);
    assert.ok(ok.run(["--settings", ok.s]).runs.length >= 4, quote);
  }
  // A bare multiple without loss, credit, premium or price words is not stated (from-description rule 3).
  const bare = stopRun("I use a 2x stop", 100);
  assert.throws(() => bare.run(["--settings", bare.s]), /^Error: BAD_RULE_SHEET: stop .*2x stop.*assumed/);
  // Tom's "1x net loss, which is two times the initial credit" (one numeric multiple, loss wording) stays 100.
  const tom = gateRun(answered());
  assert.ok(tom.run(["--settings", tom.s]).runs.length >= 4);
});

test("r71 F1: every stop example in from-description rule 3 and the review probes map to the doc's maxLoss (loses/lost are loss wording, spread is price wording)", () => {
  const want = {
    "a 1x loss": 100,
    "loss of 2x the credit": 200,
    "when the loss reaches 2x the credit": 200,
    "loses 2x the credit": 200,
    "lost 2x the credit": 200,
    "stop at 2x the credit received": 100,
    "when the spread reaches 2x": 100,
    "stop at 3x credit": 200,
    "exit when the trade loses 2x the credit": 200,
    "lost 2x the premium": 200,
    // "stop loss" is loss wording (rule 3), next to its credit-wording pair above.
    "stop loss at 2x the credit received": 200,
    "2x stop-loss on credit": 200,
    // r72 F1: one word, same reading.
    "stoploss at 2x the credit": 200,
  };
  const at = (quote) => rr.stopFromQuote({ stop: { status: "stated", quote } });
  const rule3 = readFileSync(join(here, "../skills/is-this-backtest-lambo-or-lada/references/from-description.md"), "utf8").split("\n").find((l) => l.startsWith("3. **Stops.**"));
  const examples = [...rule3.matchAll(/"([^"]*\d+(?:\.\d+)?x[^"]*)"/g)].map((m) => m[1]).filter((q) => q !== "2x stop");
  assert.ok(examples.length >= 7, examples.join(" | "));
  for (const q of examples) assert.ok(q in want, `rule 3 example not in the table: ${q}`);
  for (const [q, v] of Object.entries(want)) assert.equal(at(q), v, q);
  assert.throws(() => at("2x stop"), /^Error: BAD_RULE_SHEET: /);
  assert.throws(() => at("2x stop"), /loss, credit, premium, price or spread wording/);
});

test("r69 #4: a description build without a boolean useExactDte stops with BAD_SETTINGS naming the rule; nothing written", () => {
  const g = gateRun(answered());
  const { useExactDte, ...s } = tomSettings();
  writeFileSync(g.s, JSON.stringify(s));
  assert.throws(() => g.run(["--settings", g.s]), /^Error: BAD_SETTINGS: useExactDte not set .*0 DTE/);
  assert.deepEqual(readdirSync(g.folder), ["rule-sheet.json"], "nothing written");
});

test("r69 #12: no cost field stated -> strategy-as-built and the author_base why say Option Omega's defaults, not the author's own costs", () => {
  const g = gateRun(answered());
  const out = g.run(["--settings", g.s]);
  const md = readFileSync(join(g.folder, "strategy-as-built.md"), "utf8");
  assert.match(md, /^- Opening fees: not stated; closing fees: not stated \(Option Omega's defaults in the author run\)$/m);
  assert.doesNotMatch(md, /the author's own/);
  assert.match(out.runs.find((r) => r.role === "author_base").why, /^author costs not stated \(Option Omega's defaults\) differ from the base scenario base;/);
  // Stated costs stay the author's own.
  const { configPath } = setup();
  const p = settings().parameters;
  assert.match(strategyAsBuilt(p, {}, runRequest(settings(), loadScenarios(readConfig(configPath)), "X")), /\(the author's own\)$/m);
});
