#!/usr/bin/env node
/**
 * Keeps the architecture map from drifting silently. `pnpm check:architecture` runs it, and
 * `pnpm check` includes it. README.md says what each check catches and what it can't. Prints
 * one line per problem, naming the page and the entry, and exits 1 when there are any.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { readImports, reaches, under } from "./imports.mjs";
import { item, JOURNEY_KEYS, levelLinks, linksOf, MAP_DIR, MAP_KEYS, NODE_KINDS, parsePage, pathsOf, resolveHref, slug, STATE_MACHINES_INDEX, withoutFences } from "./js/pages.js";
import { blocks, expectedTokens, MIRRORED } from "./tokens.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const problems = [];
const fail = (where, message) => problems.push(`${where}: ${message}`);
const read = (path) => readFileSync(join(repo, path), "utf8");

// ---- The pages ----

const dir = (path) => readdirSync(join(repo, path)).filter((f) => f.endsWith(".md")).sort();
const levelFiles = dir(MAP_DIR).filter((f) => !["README.md", "AGENTS.md", "dependencies.md"].includes(f));
const flowFiles = dir(`${MAP_DIR}/flows`).filter((f) => f !== "index.md");
const journeyFiles = dir(`${MAP_DIR}/journeys`).filter((f) => f !== "index.md");

/** @type {Map<string, ReturnType<typeof parsePage>>} repo path → parsed page */
const pages = new Map();
const load = (path) => {
  const page = parsePage(read(path));
  pages.set(path, page);
  return page;
};
const levels = levelFiles.map((f) => ({ file: f, path: `${MAP_DIR}/${f}`, page: load(`${MAP_DIR}/${f}`) }));
const flows = flowFiles.map((f) => ({ file: `flows/${f}`, path: `${MAP_DIR}/flows/${f}`, page: load(`${MAP_DIR}/flows/${f}`) }));
const journeys = journeyFiles.map((f) => ({ file: `journeys/${f}`, path: `${MAP_DIR}/journeys/${f}`, page: load(`${MAP_DIR}/journeys/${f}`) }));
for (const extra of ["README.md", "dependencies.md", "flows/index.md", "journeys/index.md"]) load(`${MAP_DIR}/${extra}`);
const nameOf = (path) => path.slice(MAP_DIR.length + 1);

for (const [path, page] of pages) for (const p of page.problems) fail(`${nameOf(path)}:${p.line}`, p.message);

// ---- Links: every relative link in every page resolves, and a `#id` lands on something ----

function headingIds(path) {
  const page = pages.get(path) ?? parsePage(read(path));
  const ids = new Set(page.sections.map((s) => s.id));
  for (const m of withoutFences(read(path)).matchAll(/^#{1,6} (.+)$/gm)) ids.add(slug(m[1]));
  return ids;
}

/** Checks one link from the page at `from`. */
function checkLink(from, line, href) {
  const { path, fragment, url } = resolveHref(from, href);
  if (url) return;
  const where = `${nameOf(from)}:${line}`;
  if (path === null) return void fail(where, `link ${href} climbs out of the repository.`);
  if (!existsSync(join(repo, path))) return void fail(where, `link ${href} points at ${path}, which doesn't exist.`);
  if (fragment && path.endsWith(".md") && !headingIds(path).has(fragment))
    fail(where, `link ${href} has no #${fragment} in ${path}.`);
}

for (const path of pages.keys()) {
  withoutFences(read(path))
    .replace(/`[^`\n]*`/g, "")
    .split("\n")
    .forEach((text, i) => {
      for (const { href } of linksOf(text)) checkLink(path, i + 1, href);
    });
}

// ---- Level pages ----

const isLevelPath = (path) => levelFiles.some((f) => `${MAP_DIR}/${f}` === path);
/** Every box on every page: { id, page, kind, paths, section }. A group's paths are its own plus its child page's boxes'. */
const boxes = [];
const opened = new Set();

for (const { file, path, page } of levels) {
  if (!page.mermaid) {
    fail(file, "no mermaid block.");
    continue;
  }
  if (page.mermaid.type !== "flowchart") {
    if (page.mermaid.type) fail(`${file}:${page.mermaid.line}`, "a level page draws a flowchart.");
    continue;
  }
  const { nodes, edges } = page.mermaid;
  const nodeIds = new Set();
  for (const n of nodes) {
    if (nodeIds.has(n.id)) fail(`${file}:${n.line}`, `box ${n.id} is declared twice.`);
    nodeIds.add(n.id);
    if (!NODE_KINDS.includes(n.kind)) fail(`${file}:${n.line}`, `box ${n.id} has unknown kind ${n.kind}.`);
  }
  const sectionIds = new Set();
  for (const s of page.sections) {
    if (sectionIds.has(s.id)) fail(`${file}:${s.line}`, `section ## ${s.id} appears twice.`);
    sectionIds.add(s.id);
    if (!nodeIds.has(s.id)) fail(`${file}:${s.line}`, `section ## ${s.id} has no box in the diagram.`);
  }
  for (const n of nodes) if (!sectionIds.has(n.id)) fail(`${file}:${n.line}`, `box ${n.id} has no ## ${n.id} section.`);
  for (const e of edges) {
    for (const end of [e.from, e.to]) if (!nodeIds.has(end)) fail(`${file}:${e.line}`, `arrow ${e.from} to ${e.to} names ${end}, which isn't a box.`);
    const kind = /^(http|ws|sql|model|files|call|port|import): /.exec(e.label);
    if (kind) fail(`${file}:${e.line}`, `arrow ${e.from} to ${e.to} starts with "${kind[1]}:": arrows carry words, not kinds, and none says "import" (dependencies.md lists the broken rules).`);
  }
  const steps = edges.filter((e) => e.step !== null);
  steps.forEach((e, i) => {
    if (e.step !== i + 1) fail(`${file}:${e.line}`, `the numbered arrows must run 1, 2, 3 in order; this one is ${e.step}, expected ${i + 1}.`);
  });

  for (const s of page.sections) {
    const node = nodes.find((n) => n.id === s.id);
    if (!node) continue;
    const where = `${file}:${s.id}`;
    for (const it of s.items)
      if (!MAP_KEYS.includes(it.key)) fail(`${file}:${it.line}`, `${s.id} has a list item that isn't one of ${MAP_KEYS.join(", ")}: ${it.key ?? it.value}`);
    const kind = item(s, "Kind");
    if (!kind) fail(where, `no "Kind" item.`);
    else if (NODE_KINDS.includes(node.kind) && kind.value !== node.kind) fail(`${file}:${kind.line}`, `${s.id} says Kind: ${kind.value} but the diagram's class is ${node.kind}.`);
    if (!s.paragraphs.length) fail(where, "no sub line (the first paragraph).");
    const paths = [];
    for (const it of s.items) {
      if (it.key === "Paths") {
        for (const p of pathsOf(it.value)) {
          if (existsSync(join(repo, p))) paths.push(p);
          else fail(`${file}:${it.line}`, `${s.id} names ${p}, which doesn't exist.`);
        }
      }
      if (it.key === "Opens") {
        for (const l of linksOf(it.value)) {
          const target = resolveHref(path, l.href).path;
          if (target && !isLevelPath(target)) fail(`${file}:${it.line}`, `${s.id} Opens ${l.href}, which isn't a level page.`);
          else if (target) opened.add(target);
        }
      }
    }
    if (node.kind === "group" && !item(s, "Opens")) fail(where, `a group box needs "Opens: [label](child.md)".`);
    if (node.kind === "context" && !item(s, "See")) fail(where, `a context box needs "See: [label](page.md#id)".`);
    boxes.push({ id: s.id, page: file, path, kind: node.kind, paths, opens: item(s, "Opens")?.value ?? "" });
  }
}
for (const box of boxes) {
  if (box.kind !== "group") continue;
  const child = resolveHref(box.path, linksOf(box.opens)[0]?.href ?? "").path;
  box.paths.push(...boxes.filter((b) => b.path === child).flatMap((b) => b.paths));
}
const boxIds = new Set(boxes.map((b) => b.id));

// ---- Journeys ----

const indexLinks = linksOf(read(`${MAP_DIR}/journeys/index.md`)).map((l) => resolveHref(`${MAP_DIR}/journeys/index.md`, l.href).path);
for (const j of journeys) if (!indexLinks.includes(j.path)) fail("journeys/index.md", `doesn't link ${j.file}.`);
const readme = read(`${MAP_DIR}/README.md`);
const listed = levelLinks(readme).map((l) => l.href);
for (const l of levels)
  if (!listed.includes(l.file) && !opened.has(l.path)) fail(l.file, "is neither listed in README.md's pages nor opened by a group box.");
for (const target of ["flows/index.md", "dependencies.md", "journeys/index.md"])
  if (!linksOf(readme).some((l) => l.href === target)) fail("README.md", `doesn't link ${target}.`);

for (const { file, path, page } of journeys) {
  if (!page.sections.length) fail(file, "has no steps (## sections).");
  for (const s of page.sections) {
    for (const field of ["Does", "Sees"])
      if (!s.paragraphs.some((p) => p.startsWith(`${field}:`))) fail(`${file}:${s.id}`, `step has no "${field}:" paragraph.`);
    for (const it of s.items) {
      if (!JOURNEY_KEYS.includes(it.key)) fail(`${file}:${it.line}`, `step "${s.id}" has a list item that isn't one of ${JOURNEY_KEYS.join(", ")}: ${it.key ?? it.value}`);
      if (it.key !== "Map") continue;
      for (const l of linksOf(it.value)) {
        const target = resolveHref(path, l.href);
        const level = levels.find((lv) => lv.path === target.path);
        if (!level) fail(`${file}:${it.line}`, `step "${s.id}" Map link ${l.href} isn't a level page.`);
        else if (!target.fragment || !level.page.mermaid?.nodes.some((n) => n.id === target.fragment))
          fail(`${file}:${it.line}`, `step "${s.id}" Map link ${l.href} must end in #<box id>.`);
      }
    }
  }
}

// ---- Flows ----

const flowIndexLinks = linksOf(read(`${MAP_DIR}/flows/index.md`)).map((l) => resolveHref(`${MAP_DIR}/flows/index.md`, l.href).path);
for (const f of flows) {
  if (!flowIndexLinks.includes(f.path)) fail("flows/index.md", `doesn't link ${f.file}.`);
  const m = f.page.mermaid;
  if (m?.type !== "sequence") fail(f.file, "has no sequenceDiagram.");
  for (const p of m?.participants ?? [])
    if (!boxIds.has(p.id)) fail(`${f.file}:${p.line}`, `participant ${p.id} isn't a box id on any level page.`);
  if (!/^\d+\. /m.test(withoutFences(read(f.path)))) fail(f.file, "has no numbered steps under the diagram.");
}

// ---- State machine pages ----

const indexed = new Set();
if (!existsSync(join(repo, STATE_MACHINES_INDEX))) fail(STATE_MACHINES_INDEX, "doesn't exist.");
else {
  for (const match of read(STATE_MACHINES_INDEX).matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)) {
    if (!/^[a-z]+:/i.test(match[1])) indexed.add(posix.join(posix.dirname(STATE_MACHINES_INDEX), match[1]));
  }
}
const attached = new Set();
for (const { path, page } of levels)
  for (const s of page.sections)
    for (const it of s.items.filter((i) => i.key === "Machines"))
      for (const l of linksOf(it.value)) attached.add(resolveHref(path, l.href).path);
for (const page of indexed) {
  if (!existsSync(join(repo, page))) fail(STATE_MACHINES_INDEX, `links ${page}, which doesn't exist.`);
  else if (posix.dirname(page) !== posix.dirname(STATE_MACHINES_INDEX) && !attached.has(page))
    fail(STATE_MACHINES_INDEX, `${page} is on no box: add it to a box's Machines.`);
}
const written = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.context/*state-machine*.md"],
  { cwd: repo, encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);
for (const page of written) {
  if (page !== STATE_MACHINES_INDEX && existsSync(join(repo, page)) && !indexed.has(page)) fail(page, `isn't linked by ${STATE_MACHINES_INDEX}: add it to the index.`);
}

// ---- Dependencies ----
// dependencies.md lists the places the code breaks CONTEXT.md's rules. Every row must be a real import, and
// every real break of a written rule must have a row; ordinary imports are listed nowhere.

const DEPENDENCIES = "dependencies.md";
const roots = [...new Set(boxes.flatMap((b) => b.paths))];

// Coverage: every app, package, domain and feature has a box with a path inside it.
// From git, not the disk: a branch switch leaves untracked node_modules or build output behind.
const gitFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: repo,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);
const subdirectories = (path) => [
  ...new Set(
    gitFiles
      .filter((f) => f.startsWith(`${path}/`) && f.slice(path.length + 1).includes("/"))
      .map((f) => `${path}/${f.slice(path.length + 1).split("/")[0]}`),
  ),
];
const hasManifest = (path) => existsSync(join(repo, path, "package.json"));
for (const directory of [
  ...subdirectories("apps"),
  ...subdirectories("packages").filter(hasManifest),
  ...subdirectories("apps/server/server/domains"),
  ...subdirectories("apps/app/src/features"),
]) {
  if (!roots.some((p) => under(p, directory))) fail("map", `${directory} is in no box's Paths: add a box for it, or a path to the box that holds it.`);
}
const imports = readImports(repo, roots);

const DOMAINS = "apps/server/server/domains";
const LIB = "apps/server/server/lib";
const domainOf = (path) => (under(path, DOMAINS) ? path.slice(DOMAINS.length + 1).split("/")[0] : null);
const first = (path, n) => path.split("/").slice(0, n).join("/");

/** The breaks the code has today: { what, sample import }, one per domain direction in a cycle, per domain importing lib/, per package importing an app. */
const breaks = [];
const graph = new Map();
const sample = new Map();
const seen = new Set();
for (const i of imports) {
  const from = domainOf(i.from);
  const to = domainOf(i.to);
  if (from && to && from !== to && !i.typeOnly) {
    if (!graph.has(from)) graph.set(from, new Set());
    graph.get(from).add(to);
    if (!sample.has(`${from}>${to}`)) sample.set(`${from}>${to}`, i);
  }
  const once = (key, what) => {
    if (seen.has(key)) return;
    seen.add(key);
    breaks.push({ what, imp: i });
  };
  if (from && under(i.to, LIB) && !i.typeOnly) once(`lib>${from}`, `domain ${from} importing lib/`);
  if (i.from.startsWith("packages/") && i.to.startsWith("apps/")) once(`app>${first(i.from, 2)}>${first(i.to, 2)}`, `${first(i.from, 2)} importing ${first(i.to, 2)}`);
}
const component = stronglyConnected(graph);
for (const [from, targets] of graph)
  for (const to of targets)
    if (component.get(from) === component.get(to)) breaks.push({ what: `domain ${from} importing domain ${to} inside a cycle`, imp: sample.get(`${from}>${to}`) });

/** The repo paths a table cell names: a path that exists, or a box id (a box with Paths). */
const rootsOf = (cell) => {
  const name = cell.replaceAll("`", "").trim();
  if (name && existsSync(join(repo, name))) return [name];
  return boxes.filter((b) => b.id === name && b.kind !== "context").flatMap((b) => b.paths);
};

const rows = [];
withoutFences(read(`${MAP_DIR}/${DEPENDENCIES}`)).split("\n").forEach((text, i) => {
  if (!text.trim().startsWith("|")) return;
  const cells = text.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  if (cells.every((c) => /^:?-+:?$/.test(c))) return;
  if (cells[0].toLowerCase() === "from") {
    if (cells.map((c) => c.toLowerCase()).join("|") !== "from|to|rule|example file") fail(`${DEPENDENCIES}:${i + 1}`, "the table header must be: | from | to | rule | example file |");
    return;
  }
  rows.push({ cells, line: i + 1 });
});
if (!rows.length) fail(DEPENDENCIES, "has no table of broken rules (| from | to | rule | example file |).");

for (const row of rows) {
  const where = `${DEPENDENCIES}:${row.line}`;
  const [from, to, rule, example] = row.cells;
  if (row.cells.length !== 4 || !rule) {
    fail(where, "a row has four cells: from, to, rule, example file.");
    continue;
  }
  const fromRoots = rootsOf(from);
  const toRoots = rootsOf(to);
  if (!fromRoots.length) fail(where, `${from} is neither a repo path nor a box id with Paths.`);
  if (!toRoots.length) fail(where, `${to} is neither a repo path nor a box id with Paths.`);
  if (!fromRoots.length || !toRoots.length) continue;
  const file = example.replaceAll("`", "").trim();
  const real = imports.filter((i) => fromRoots.some((r) => under(i.from, r)) && toRoots.some((r) => reaches(i, r)));
  row.imports = real;
  if (!real.length) fail(where, `${from} to ${to}: nothing in ${from}'s paths imports ${to}'s.`);
  else if (!existsSync(join(repo, file))) fail(where, `example file ${file} doesn't exist.`);
  else if (!real.some((i) => i.from === file)) fail(where, `example file ${file} doesn't import ${to}.`);
}
for (const b of breaks) {
  const covered = rows.some((r) => r.imports?.includes(b.imp));
  if (!covered) fail(DEPENDENCIES, `no row for ${b.what}: ${b.imp.from} imports ${b.imp.to}.`);
}

/** Tarjan: node → component number; nodes in one cycle share one, and a lone node gets its own. */
function stronglyConnected(adjacency) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const result = new Map();
  let counter = 0;
  let components = 0;
  const visit = (v) => {
    index.set(v, counter);
    low.set(v, counter++);
    stack.push(v);
    onStack.add(v);
    for (const w of adjacency.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        result.set(w, components);
      } while (w !== v);
      components++;
    }
  };
  for (const v of adjacency.keys()) if (!index.has(v)) visit(v);
  return result;
}

// ---- Tokens ----

const { light, dark } = expectedTokens(repo);
const mirror = blocks(readFileSync(join(here, "styles/tokens.css"), "utf8"));
for (const [selector, expected] of [
  [':root, [data-theme="light"]', light],
  [':root:not([data-theme="light"])', dark],
  [':root[data-theme="dark"]', dark],
]) {
  const props = mirror.get(selector);
  if (!props) {
    fail("styles/tokens.css", `has no ${selector} block.`);
    continue;
  }
  for (const name of MIRRORED) {
    if (props[name] === undefined) fail("styles/tokens.css", `${selector} lacks --${name}.`);
    else if (props[name] !== expected[name])
      fail("styles/tokens.css", `${selector} --${name} is ${props[name]}; packages/design-tokens says ${expected[name]}.`);
  }
  for (const name of Object.keys(props))
    if (!MIRRORED.includes(name)) fail("styles/tokens.css", `${selector} sets --${name}, which tokens.mjs doesn't list.`);
}

// Only tokens.css may hold a colour; the page sheet uses its variables.
const defined = new Set([...mirror.values()].flatMap((props) => Object.keys(props)));
{
  const css = readFileSync(join(here, "styles/page.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of css.matchAll(/(--[\w-]+)\s*:/g)) defined.add(match[1].slice(2));
  const raw = css.match(/#[0-9a-fA-F]{3,8}\b|\b(?:oklch|oklab|rgba?|hsla?|hwb|lab|lch)\(/g);
  if (raw) fail("styles/page.css", `holds a raw colour (${raw[0]}): use a variable from tokens.css.`);
  for (const match of css.matchAll(/var\(\s*--([\w-]+)\s*(,)?/g))
    if (!defined.has(match[1]) && !match[2]) fail("styles/page.css", `uses --${match[1]}, which no stylesheet here defines.`);
}

if (problems.length) {
  console.error(`architecture map: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
const edgeCount = levels.reduce((n, l) => n + (l.page.mermaid?.edges.length ?? 0), 0);
console.log(
  `architecture map: ${levels.length} levels, ${boxes.length} boxes, ${edgeCount} arrows, ${flows.length} flows, ${rows.length} broken-rule rows, ${journeys.length} journeys, ${imports.length} imports read, ${attached.size} state machine pages on boxes, ${written.length} state machine pages, all in the index`,
);
