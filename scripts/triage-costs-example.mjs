#!/usr/bin/env node
// Maintainer export of the example cost scenario for is-this-backtest-lambo-or-lada.
//
// Writes skills/is-this-backtest-lambo-or-lada/templates/costs-example.json from
// one scenario of the maintainer's own cost source (a file or a command that
// prints the cost-scenario JSON, as in the local config). The public file gets
// the five values under the name "example", a generic source label, the export
// date and the sha256 of the values; the source's path and scenario name stay
// private.
//
//   node triage-costs-example.mjs --scenario <name> (--file <path> | --command <argv...>)
//     [--out <path>] [--date YYYY-MM-DD] [--source "<label>"]
//
// --command takes the rest of the arguments. Errors: "REASON: detail", exit 1.

import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  COST_FIELDS,
  EXAMPLE_NAME,
  EXAMPLE_PATH,
  exampleSha256,
  loadScenarios,
} from "./triage-config.mjs";

const SOURCE = "maintainer's researched SPX scenario, IBKR-style fees";

function fail(reason, detail) {
  throw new Error(`${reason}: ${detail}`);
}

export function exportExample(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--command") {
      opts.command = argv.slice(i + 1);
      break;
    }
    if (!["--scenario", "--file", "--out", "--date", "--source"].includes(k) || argv[i + 1] === undefined)
      fail("USAGE", "triage-costs-example.mjs --scenario <name> (--file <path> | --command <argv...>) [--out <path>] [--date YYYY-MM-DD] [--source <label>]");
    opts[k.slice(2)] = argv[++i];
  }
  if (!opts.scenario || !opts.file === !(opts.command?.length > 0))
    fail("USAGE", "--scenario and exactly one of --file or --command are required");
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("USAGE", "--date is YYYY-MM-DD");
  // Same reading and checks as a triage run: every field a number >= 0.
  const { base } = loadScenarios({
    costs: { file: opts.file ?? null, command: opts.command ?? null, cwd: process.cwd(), base: opts.scenario },
  });
  const template = JSON.parse(readFileSync(EXAMPLE_PATH.replace("costs-example.json", "costs.json"), "utf8"));
  const values = Object.fromEntries(COST_FIELDS.map((f) => [f, base[f]]));
  const out = {
    description:
      "Example cost scenario for a first try of is-this-backtest-lambo-or-lada when you have no cost file of your own. These are not your costs: the first-run setup shows them and uses them only after you confirm, and every summary and verdict-log entry then says \"costs: example (not your own)\" with C7 capped. Found them wrong for your broker? Give feedback, and use your own cost file (templates/costs.json).",
    source: opts.source ?? SOURCE,
    exportedAt: date,
    sha256: exampleSha256(values),
    fields: template.fields,
    scenarios: { [EXAMPLE_NAME]: values },
  };
  const path = opts.out ?? EXAMPLE_PATH;
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  return { written: path, sha256: out.sha256, exportedAt: date };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(JSON.stringify(exportExample(process.argv.slice(2)), null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
