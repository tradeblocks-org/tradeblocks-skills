#!/usr/bin/env node
// Fail when a tracked Markdown file links to a repository file that does not exist.
// Checks inline links and images, `[text](target)`; external URLs and in-page anchors are skipped.
// Destinations follow CommonMark: `<...>` or balanced/backslash-escaped parentheses, with an
// optional title; `?query` and `#fragment` are not part of the file path.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const files = execFileSync("git", ["ls-files", "-z", "*.md"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const opener = /\[[^\]]*\]\(/g;
const external = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i;
const titleClose = { '"': '"', "'": "'", "(": ")" };
const missing = [];

// Parse an inline link from `i`, just after `](`. Returns the raw destination and the index past
// the link's closing `)`, or null when the text there is not a link.
function destination(line, i) {
  while (line[i] === " " || line[i] === "\t") i++;
  let target = "";
  if (line[i] === "<") {
    const end = line.indexOf(">", i + 1);
    if (end < 0) return null;
    target = line.slice(i + 1, end);
    i = end + 1;
  } else {
    let depth = 0;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === "\\" && /[()\\]/.test(line[i + 1] ?? "")) {
        target += line[++i];
        continue;
      }
      if (c === " " || c === "\t") break;
      if (c === "(") depth++;
      else if (c === ")" && depth-- === 0) break;
      target += c;
    }
    if (depth > 0) return null;
  }
  while (line[i] === " " || line[i] === "\t") i++;
  const close = titleClose[line[i]];
  if (close) {
    for (i++; i < line.length && line[i] !== close; i++) if (line[i] === "\\") i++;
    if (i >= line.length) return null;
    i++;
    while (line[i] === " " || line[i] === "\t") i++;
  }
  return line[i] === ")" && target ? { target, end: i + 1 } : null;
}

for (const file of files) {
  let fence = null;
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (fence) {
      // A closing fence repeats the opener's character at least as many times, with no info string.
      const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      return;
    }
    const open = line.match(/^\s*(`{3,}|~{3,})/);
    if (open) {
      fence = open[1];
      return;
    }
    const text = line.replace(/`[^`]*`/g, "");
    opener.lastIndex = 0;
    while (opener.exec(text)) {
      const link = destination(text, opener.lastIndex);
      if (!link) continue;
      opener.lastIndex = link.end; // a title's text is not scanned for further links
      if (external.test(link.target)) continue;
      const path = decodeURIComponent(link.target.split(/[?#]/)[0]);
      if (path && !existsSync(join(dirname(file), path))) missing.push(`${file}:${i + 1}: ${link.target}`);
    }
  });
}

if (missing.length) {
  console.error(`Broken relative links (${missing.length}):\n${missing.join("\n")}`);
  process.exit(1);
}
console.log(`Relative links resolve in ${files.length} Markdown files.`);
