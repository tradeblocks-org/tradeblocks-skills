#!/usr/bin/env node
// Fail when a tracked Markdown file links to a repository file that does not exist.
// Checks inline links and images, `[text](target)`; external URLs and in-page anchors are skipped.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const files = execFileSync("git", ["ls-files", "-z", "*.md"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const link = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*)?\)/g;
const external = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i;
const missing = [];

for (const file of files) {
  let fence = null;
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    for (const [, target] of line.replace(/`[^`]*`/g, "").matchAll(link)) {
      if (external.test(target)) continue;
      const path = decodeURIComponent(target.split("#")[0]);
      if (!existsSync(join(dirname(file), path))) missing.push(`${file}:${i + 1}: ${target}`);
    }
  });
}

if (missing.length) {
  console.error(`Broken relative links (${missing.length}):\n${missing.join("\n")}`);
  process.exit(1);
}
console.log(`Relative links resolve in ${files.length} Markdown files.`);
