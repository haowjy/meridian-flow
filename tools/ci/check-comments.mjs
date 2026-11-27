#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSource, sourceComments } from "./source-comments.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const BASELINE_NAME = "tools/ci/comment-baseline.txt";
const BASELINE_PATH = resolve(ROOT, BASELINE_NAME);
const UPDATE_COMMAND = "pnpm check:comments --update-baseline";
const EXCLUDED =
  /(^|\/)(node_modules|dist|build|vendor|migrations|locales)\/|\.(gen|generated)\.[cm]?[jt]sx?$/;
const TOOL_READ =
  /^(@vitest-environment|@jest-environment|@vite-ignore|[@#]__PURE__|@jsxImportSource|@jsxRuntime|@ts-check|slop-lint:\s*allow|prettier-ignore|(v8|c8|istanbul) ignore|webpack[A-Z]\w+:|@refresh|@generated)\b/;
const SUPPRESSION = /^(biome-ignore(-all)?|@ts-(ignore|expect-error|nocheck))\b/;

const update = process.argv.slice(2).includes("--update-baseline");

function sourcePaths() {
  const patterns = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].map((ext) => `*.${ext}`);
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...patterns],
    { cwd: ROOT },
  )
    .toString()
    .split("\0")
    .filter((path) => path && existsSync(resolve(ROOT, path)) && !EXCLUDED.test(path));
}

function bodyLines(comment) {
  return comment
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^(\/\/+|\/\*+|\*+(?!\/))/, "")
        .replace(/\*+\/$/, "")
        .trim(),
    )
    .filter(Boolean);
}

function proseText(comment, path) {
  if (/^\/\/\/\s*<reference/.test(comment)) return "";
  const lines = bodyLines(comment);
  if (lines.length > 0 && (TOOL_READ.test(lines[0]) || SUPPRESSION.test(lines[0]))) return "";
  const prose = /\.[cm]?jsx?$/.test(path) ? lines.filter((line) => !line.startsWith("@")) : lines;
  return prose.length === 0 ? "" : lines.join(" ").replace(/\s+/g, " ");
}

function fileComments(path) {
  const text = readFileSync(resolve(ROOT, path), "utf8");
  const sourceFile = parseSource(path, text);
  const lineOf = (position) => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  const ownLine = (comment) =>
    text.slice(text.lastIndexOf("\n", comment.start - 1) + 1, comment.start).trim() === "";
  const found = [];
  let previous;
  for (const comment of sourceComments(sourceFile, text)) {
    const prose = proseText(comment.text, path);
    if (!prose) {
      previous = undefined;
      continue;
    }
    const lineComment = comment.text.startsWith("//") && ownLine(comment);
    if (lineComment && previous && lineOf(comment.start) === previous.endLine + 1) {
      previous.endLine = lineOf(comment.end);
      previous.text = `${previous.text} ${prose}`;
      continue;
    }
    const record = {
      endLine: lineOf(comment.end),
      lineNumber: lineOf(comment.start),
      path,
      text: prose,
    };
    found.push(record);
    previous = lineComment ? record : undefined;
  }
  return found;
}

function entryOf(comment) {
  return `${comment.path}\t${comment.text}`;
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    if (update) return [];
    throw new Error(`${BASELINE_NAME} is missing; create it with ${UPDATE_COMMAND}`);
  }
  return readFileSync(BASELINE_PATH, "utf8").split("\n").filter(Boolean);
}

function countTexts(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const text = entry.slice(entry.indexOf("\t") + 1);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return counts;
}

function excess(current, baseline) {
  const left = countTexts(baseline);
  const extra = [];
  for (const entry of current) {
    const text = entry.slice(entry.indexOf("\t") + 1);
    const count = left.get(text) ?? 0;
    left.set(text, count - 1);
    if (count < 1) extra.push(entry);
  }
  return extra;
}

function clip(text) {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function main() {
  const started = performance.now();
  const comments = sourcePaths().flatMap(fileComments);
  const current = comments.map(entryOf).sort();
  const baseline = readBaseline();
  const seconds = ((performance.now() - started) / 1000).toFixed(1);

  if (update) {
    const added = excess(current, baseline);
    const removed = excess(baseline, current).length;
    writeFileSync(BASELINE_PATH, current.map((entry) => `${entry}\n`).join(""));
    console.log(
      `Comment baseline records ${current.length} comments (${added.length} added, ${removed} removed).`,
    );
    for (const entry of added) console.log(`  + ${clip(entry.replace("\t", "  "))}`);
    return;
  }

  const fresh = new Set(excess(current, baseline));
  if (fresh.size > 0) {
    const lines = comments
      .filter((comment) => fresh.delete(entryOf(comment)))
      .map((comment) => `  ${comment.path}:${comment.lineNumber}  ${clip(comment.text)}`);
    console.error(
      `Comment check failed: new or changed comments.\n${lines.join("\n")}\n\n` +
        "A comment is for a rule the code must obey where breaking it fails somewhere else or later\n" +
        "and nothing at the spot shows it, or for behavior an outside system forces. Never for what\n" +
        "the code does or why the product behaves as it does: delete it, or move the words into names.\n" +
        `If it is that kind of comment, record it with ${UPDATE_COMMAND} and commit the baseline line.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Comment check passed (${current.length} comments; ${seconds}s).`);
}

try {
  main();
} catch (error) {
  console.error(`Comment check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
