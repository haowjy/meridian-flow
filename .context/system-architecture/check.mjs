#!/usr/bin/env node
/**
 * Keeps the architecture map from drifting silently. `pnpm check:architecture` runs it, and
 * `pnpm check` includes it. Fails (exit 1, one line per problem) when:
 * - the map's data is malformed (the same `validate` the page runs);
 * - a path in a box's or level's `paths`, `docs` or `machines` doesn't exist in the repo;
 * - a page that `.context/state-machines/index.md` links is on no box (the pages beside the
 *   index, the patterns, are reached from the header instead);
 * - a `.context/**\/*state-machine*.md` is not linked by the index, so the index is complete;
 * - styles/tokens.css differs from packages/design-tokens, its two dark blocks differ, or a
 *   page stylesheet holds a raw colour or uses a variable nothing defines.
 * It can't tell whether a box's words are still true: that stays a review point.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { expectedTokens, MIRRORED } from "./tokens.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const problems = [];

// The page's data and model are classic browser scripts that set globals; run them the same way.
const sandbox = {};
sandbox.globalThis = sandbox;
for (const file of ["architecture.js", "js/model.js"]) {
  runInNewContext(readFileSync(join(here, file), "utf8"), sandbox, { filename: file });
}
const data = sandbox.ARCHITECTURE;
const { model } = sandbox.ArchMap;

problems.push(...model.validate(data));
// Everything below walks the levels, so a malformed map stops here with its problems.
if (problems.length) report();

for (const { path, where } of model.repoPaths(data)) {
  if (!existsSync(join(repo, path))) problems.push(`${where} names ${path}, which doesn't exist.`);
}

// ---- State machine pages ----

const INDEX = ".context/state-machines/index.md";
const linked = new Set();
if (!existsSync(join(repo, INDEX))) problems.push(`${INDEX} doesn't exist.`);
else {
  const text = readFileSync(join(repo, INDEX), "utf8");
  for (const match of text.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)) {
    if (!/^[a-z]+:/i.test(match[1])) linked.add(posix.join(posix.dirname(INDEX), match[1]));
  }
}
const attached = new Set(
  data.levels.flatMap((level) => level.nodes.flatMap((node) => node.machines ?? [])),
);
for (const page of linked) {
  if (!existsSync(join(repo, page))) problems.push(`${INDEX} links ${page}, which doesn't exist.`);
  else if (posix.dirname(page) !== posix.dirname(INDEX) && !attached.has(page))
    problems.push(`${page} is linked by ${INDEX} but is on no box: add it to a box's machines.`);
}
const written = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.context/*state-machine*.md"],
  { cwd: repo, encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);
for (const page of written) {
  if (page !== INDEX && existsSync(join(repo, page)) && !linked.has(page))
    problems.push(`${page} is not linked by ${INDEX}: add it to the index.`);
}

// ---- Tokens ----

/** Custom properties by block, from a CSS file: selector text (whitespace-collapsed) to {name: value}. */
function blocks(css) {
  const out = new Map();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].replace(/\s+/g, " ").trim();
    const props = {};
    for (const decl of match[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
      props[decl[1].slice(2)] = decl[2].replace(/\s+/g, " ").trim();
    out.set(selector, { ...out.get(selector), ...props });
  }
  return out;
}

const { light, dark } = expectedTokens(repo);
const mirror = blocks(readFileSync(join(here, "styles/tokens.css"), "utf8"));
for (const [selector, expected] of [
  [':root, [data-theme="light"]', light],
  [':root:not([data-theme="light"])', dark],
  [':root[data-theme="dark"]', dark],
]) {
  const props = mirror.get(selector);
  if (!props) {
    problems.push(`styles/tokens.css has no ${selector} block.`);
    continue;
  }
  for (const name of MIRRORED) {
    if (props[name] === undefined) problems.push(`styles/tokens.css ${selector} lacks --${name}.`);
    else if (props[name] !== expected[name])
      problems.push(
        `styles/tokens.css ${selector} --${name} is ${props[name]}; packages/design-tokens says ${expected[name]}.`,
      );
  }
  for (const name of Object.keys(props))
    if (!MIRRORED.includes(name))
      problems.push(`styles/tokens.css ${selector} sets --${name}, which tokens.mjs doesn't list.`);
}

// Only tokens.css may hold a colour; the page sheets use its variables.
const defined = new Set([...mirror.values()].flatMap((props) => Object.keys(props)));
for (const sheet of ["styles/page.css"]) {
  const css = readFileSync(join(here, sheet), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of css.matchAll(/(--[\w-]+)\s*:/g)) defined.add(match[1].slice(2));
  const raw = css.match(/#[0-9a-fA-F]{3,8}\b|\b(?:oklch|oklab|rgba?|hsla?|hwb|lab|lch)\(/g);
  if (raw) problems.push(`${sheet} holds a raw colour (${raw[0]}): use a variable from tokens.css.`);
  for (const match of css.matchAll(/var\(\s*--([\w-]+)\s*(,)?/g)) {
    // A var() with a fallback, or one of React Flow's own --xy-*, may be undefined on purpose.
    if (!defined.has(match[1]) && !match[2] && !match[1].startsWith("xy-"))
      problems.push(`${sheet} uses --${match[1]}, which no stylesheet here defines.`);
  }
}

report();
console.log(
  `architecture map: ${data.levels.length} levels, ${model.repoPaths(data).length} paths present, ${attached.size} state machine pages on boxes, ${written.length} state machine pages, all in the index`,
);

/** Prints the problems and exits 1 when there are any. */
function report() {
  if (!problems.length) return;
  console.error(`architecture map: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
