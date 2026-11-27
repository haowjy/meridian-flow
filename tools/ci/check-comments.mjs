#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSource, sourceComments } from "./source-comments.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const BASELINE_PATH = resolve(ROOT, "tools/ci/comment-baseline.json");
const BASELINE_NAME = "tools/ci/comment-baseline.json";
const ACCEPT_COMMAND = "pnpm check:comments --accept";
const EXCLUDED =
  /(^|\/)(node_modules|dist|build|vendor|migrations|locales)\/|\.(gen|generated)\.[cm]?[jt]sx?$/;
const TOOL_READ =
  /^\/\/\/\s*<reference|@vitest-environment|@jest-environment|@vite-ignore|[@#]__PURE__|@jsxImportSource|@jsxRuntime|@ts-check|slop-lint:\s*allow|prettier-ignore|^\/\*\s*(v8|c8|istanbul) ignore|webpack[A-Z]\w+:|^\/\/\s*@(refresh|generated)/;
const SUPPRESSION =
  /\bbiome-ignore(?:-all)?\b|@ts-(?:ignore|expect-error|nocheck)\b|eslint-disable/;
const JS_TYPE_TAG = /@(type|param|returns?|typedef|template|satisfies|callback|property|import)\b/;

const accept = process.argv.slice(2).includes("--accept");

function sourcePaths() {
  const patterns = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].flatMap((extension) =>
    ["apps", "packages", "tools"].map((area) => `${area}/**/*.${extension}`),
  );
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...patterns],
    { cwd: ROOT },
  )
    .toString()
    .split("\0")
    .filter((path) => path && !EXCLUDED.test(path));
}

function isProse(comment, path) {
  return !(
    SUPPRESSION.test(comment) ||
    TOOL_READ.test(comment) ||
    (/\.[cm]?jsx?$/.test(path) && JS_TYPE_TAG.test(comment))
  );
}

function firstWords(comment) {
  for (const line of comment.split("\n")) {
    const words = line
      .trim()
      .replace(/^(\/\/+|\/\*+|\*+\/|\*+)/, "")
      .replace(/\*+\/$/, "")
      .trim();
    if (words) return words;
  }
  return "";
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
    if (!isProse(comment.text, path)) {
      previous = undefined;
      continue;
    }
    const lineComment = comment.text.startsWith("//") && ownLine(comment);
    if (lineComment && previous && lineOf(comment.start) === previous.endLine + 1) {
      previous.endLine = lineOf(comment.end);
      continue;
    }
    previous = lineComment ? { endLine: lineOf(comment.end) } : undefined;
    found.push({ line: firstWords(comment.text), lineNumber: lineOf(comment.start), path });
  }
  return found;
}

function keyOf(path, line) {
  return `${path}\0${line}`;
}

function readBaseline() {
  let text;
  let parsed;
  try {
    text = readFileSync(BASELINE_PATH, "utf8");
    parsed = JSON.parse(text);
  } catch (error) {
    if (accept && error.code === "ENOENT") return { entries: [], text: "" };
    throw new Error(`cannot read ${BASELINE_NAME}: ${error.message}`);
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.comments)) {
    throw new Error(`${BASELINE_NAME} must have version 1 and a comments array`);
  }
  for (const entry of parsed.comments) {
    if (
      typeof entry?.path !== "string" ||
      typeof entry.line !== "string" ||
      !Number.isInteger(entry.count) ||
      entry.count < 1
    ) {
      throw new Error(`invalid ${BASELINE_NAME} entry ${JSON.stringify(entry)}`);
    }
  }
  return { entries: parsed.comments, text };
}

function serialize(comments) {
  const counts = new Map();
  for (const { path, line } of comments) {
    const key = keyOf(path, line);
    counts.set(key, { path, line, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  const entries = [...counts.values()].sort(
    (left, right) => left.path.localeCompare(right.path) || left.line.localeCompare(right.line),
  );
  return `${JSON.stringify({ version: 1, comments: entries }, null, 2)}\n`;
}

function unaccepted(comments, baseline) {
  const exact = new Map();
  for (const entry of baseline) {
    const key = keyOf(entry.path, entry.line);
    exact.set(key, (exact.get(key) ?? 0) + entry.count);
  }
  const pending = comments.filter((comment) => {
    const key = keyOf(comment.path, comment.line);
    const left = exact.get(key) ?? 0;
    exact.set(key, left - 1);
    return left < 1;
  });

  const pathsByWords = new Map();
  const freeByPath = new Map();
  for (const [key, count] of exact) {
    const [path, line] = key.split("\0");
    for (let index = 0; index < count; index += 1) {
      pathsByWords.set(line, [...(pathsByWords.get(line) ?? []), path]);
    }
    if (count > 0) freeByPath.set(path, (freeByPath.get(path) ?? 0) + count);
  }
  const unmoved = pending.filter((comment) => {
    const from = pathsByWords.get(comment.line)?.pop();
    if (from === undefined) return true;
    freeByPath.set(from, freeByPath.get(from) - 1);
    return false;
  });

  const files = new Map();
  for (const comment of unmoved) {
    const file = files.get(comment.path) ?? { comments: [], count: 0 };
    file.comments.push(comment);
    const free = freeByPath.get(comment.path) ?? 0;
    if (free > 0) freeByPath.set(comment.path, free - 1);
    else file.count += 1;
    files.set(comment.path, file);
  }
  return [...files.entries()].filter(([, file]) => file.count > 0);
}

function main() {
  const started = performance.now();
  const comments = sourcePaths().flatMap(fileComments);
  const current = serialize(comments);
  const { entries: baseline, text: written } = readBaseline();
  const seconds = ((performance.now() - started) / 1000).toFixed(1);

  if (accept) {
    if (current !== written) writeFileSync(BASELINE_PATH, current);
    console.log(
      `Comment baseline records ${comments.length} comments; commit ${BASELINE_NAME} with the change.`,
    );
    return;
  }

  const rejected = unaccepted(comments, baseline);
  if (rejected.length > 0) {
    const files = rejected.map(([, file]) => {
      const lines = file.comments.map(
        (comment) => `  ${comment.path}:${comment.lineNumber}  ${comment.line}`,
      );
      if (file.comments.length > file.count) {
        lines.push(
          `    (${file.count} of these ${file.count === 1 ? "is" : "are"} new; the rest replace comments this file lost)`,
        );
      }
      return lines.join("\n");
    });
    console.error(
      `Comment check failed: new comments.\n${files.join("\n")}\n\n` +
        "A comment is for a rule the code must obey where breaking it fails somewhere else or later\n" +
        "and nothing at the spot shows it, or for behavior an outside system forces. Never for what\n" +
        "the code does or why the product behaves as it does: delete it, or move the words into names.\n" +
        `If it is that kind of comment, accept it and commit the baseline line: ${ACCEPT_COMMAND}`,
    );
    process.exitCode = 1;
    return;
  }

  if (current !== written) {
    writeFileSync(BASELINE_PATH, current);
    const before = baseline.reduce((sum, entry) => sum + entry.count, 0);
    console.log(
      `Comment check passed (${comments.length} comments; ${seconds}s). ` +
        `Updated ${BASELINE_NAME} from ${before}; commit it with the change.`,
    );
    return;
  }
  console.log(`Comment check passed (${comments.length} comments; ${seconds}s).`);
}

try {
  main();
} catch (error) {
  console.error(`Comment check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
