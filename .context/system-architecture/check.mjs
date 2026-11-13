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
import { EDGE_KINDS, item, JOURNEY_KEYS, levelLinks, linksOf, MAP_DIR, MAP_KEYS, NODE_KINDS, parsePage, pathsOf, resolveHref, slug, STATE_MACHINES_INDEX, withoutFences } from "./js/pages.js";
import { blocks, expectedTokens, MIRRORED } from "./tokens.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const problems = [];
const fail = (where, message) => problems.push(`${where}: ${message}`);
const read = (path) => readFileSync(join(repo, path), "utf8");

// ---- The pages ----

const dir = (path) => readdirSync(join(repo, path)).filter((f) => f.endsWith(".md")).sort();
const levelFiles = dir(MAP_DIR).filter((f) => f !== "README.md" && f !== "AGENTS.md");
const journeyFiles = dir(`${MAP_DIR}/journeys`).filter((f) => f !== "index.md");

/** @type {Map<string, ReturnType<typeof parsePage>>} repo path → parsed page */
const pages = new Map();
const load = (path) => {
  const page = parsePage(read(path));
  pages.set(path, page);
  return page;
};
const levels = levelFiles.map((f) => ({ file: f, path: `${MAP_DIR}/${f}`, page: load(`${MAP_DIR}/${f}`) }));
const journeys = journeyFiles.map((f) => ({ file: `journeys/${f}`, path: `${MAP_DIR}/journeys/${f}`, page: load(`${MAP_DIR}/journeys/${f}`) }));
for (const extra of ["README.md", "journeys/index.md"]) load(`${MAP_DIR}/${extra}`);
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
/** Every box on every page: { id, page, kind, paths, section }. */
const boxes = [];

for (const { file, path, page } of levels) {
  if (!page.mermaid) {
    fail(file, "no mermaid block.");
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
    if (!EDGE_KINDS.includes(e.kind)) fail(`${file}:${e.line}`, `edge ${e.from} to ${e.to} has unknown kind ${e.kind}.`);
    for (const end of [e.from, e.to]) if (!nodeIds.has(end)) fail(`${file}:${e.line}`, `edge ${e.from} to ${e.to} names ${end}, which isn't a box.`);
  }

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
        }
      }
    }
    if (node.kind === "context" && !item(s, "See")) fail(where, `a context box needs "See: [label](page.md#id)".`);
    boxes.push({ id: s.id, page: file, kind: node.kind, paths });
  }
}

// ---- Journeys ----

const indexLinks = linksOf(read(`${MAP_DIR}/journeys/index.md`)).map((l) => resolveHref(`${MAP_DIR}/journeys/index.md`, l.href).path);
for (const j of journeys) if (!indexLinks.includes(j.path)) fail("journeys/index.md", `doesn't link ${j.file}.`);
const readme = read(`${MAP_DIR}/README.md`);
const listed = levelLinks(readme).map((l) => l.href);
for (const l of levels) if (!listed.includes(l.file)) fail("README.md", `doesn't list ${l.file} among the pages.`);
if (!linksOf(readme).some((l) => l.href === "journeys/index.md")) fail("README.md", "doesn't link journeys/index.md.");

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

// ---- Imports ----

const roots = [...new Set(boxes.flatMap((b) => b.paths))];

// Coverage: every app, package, domain and feature has a box with a path inside it.
const subdirectories = (path, wanted = () => true) =>
  readdirSync(join(repo, path), { withFileTypes: true })
    .filter((e) => e.isDirectory() && wanted(e.name))
    .map((e) => `${path}/${e.name}`);
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
const covers = (box, imp) => box.paths.some((p) => reaches(imp, p));

for (const { file, page } of levels) {
  for (const e of page.mermaid?.edges ?? []) {
    if (e.kind !== "import" && e.kind !== "call") continue;
    const a = boxes.find((b) => b.page === file && b.id === e.from);
    const z = boxes.find((b) => b.page === file && b.id === e.to);
    if (!a?.paths.length || !z?.paths.length) continue;
    const backed = (x, y) => imports.some((i) => x.paths.some((p) => under(i.from, p)) && covers(y, i));
    if (!backed(a, z) && !(e.both && backed(z, a)))
      fail(`${file}:${e.line}`, `${e.kind} edge ${e.from} to ${e.to} has no import behind it: nothing in ${e.from}'s paths imports ${e.to}'s.`);
  }
}

/** Whether the page both boxes are on has an edge from `a` to `z` (or either way, with `eitherWay`) whose label says "breaks:". */
const marked = (a, z, eitherWay = false) =>
  a.page === z.page &&
  levels
    .find((l) => l.file === a.page)
    .page.mermaid.edges.some(
      (e) =>
        e.label.includes("breaks:") &&
        ((e.from === a.id && e.to === z.id) || ((e.both || eitherWay) && e.from === z.id && e.to === a.id)),
    );

const DOMAINS = "apps/server/server/domains";
const LIB = "apps/server/server/lib";
const domainOf = (path) => (under(path, DOMAINS) ? path.slice(DOMAINS.length + 1).split("/")[0] : null);
const domainBox = (name) => boxes.find((b) => b.kind === "domain" && b.paths.includes(`${DOMAINS}/${name}`));

// Rule: domains are acyclic. Every domain-to-domain value import inside a cycle needs a marked edge in its own direction.
const graph = new Map();
const sample = new Map();
for (const i of imports) {
  const from = domainOf(i.from);
  const to = domainOf(i.to);
  if (!from || !to || from === to || i.typeOnly) continue;
  if (!graph.has(from)) graph.set(from, new Set());
  graph.get(from).add(to);
  sample.set(`${from}>${to}`, sample.get(`${from}>${to}`) ?? `${i.from} imports ${i.to}`);
}
const component = stronglyConnected(graph);
const noBox = new Set();
for (const [from, targets] of graph) {
  for (const to of targets) {
    if (component.get(from) !== component.get(to)) continue;
    const a = domainBox(from);
    const z = domainBox(to);
    for (const [name, box] of [[from, a], [to, z]])
      if (!box && !noBox.has(name)) {
        noBox.add(name);
        fail("map", `domain ${name} is in an import cycle but has no domain box (Paths: \`${DOMAINS}/${name}\`).`);
      }
    if (a && z && !marked(a, z))
      fail(a.page, `no edge from ${from} to ${to} carries "breaks:", yet ${sample.get(`${from}>${to}`)} inside a domain cycle.`);
  }
}

// Rule: domains do not import lib/. One marked edge between a domain's box and a lib box covers all that domain's imports.
const libSeen = new Set();
for (const i of imports) {
  const from = domainOf(i.from);
  if (!from || !under(i.to, LIB)) continue;
  const key = from;
  if (libSeen.has(key)) continue;
  libSeen.add(key);
  const a = domainBox(from);
  const libBoxes = boxes.filter((b) => b.kind !== "domain" && b.paths.some((p) => under(i.to, p)) && b.page === a?.page);
  if (!a) fail("map", `domain ${from} imports lib/ but has no domain box (Paths: \`${DOMAINS}/${from}\`).`);
  else if (!libBoxes.some((z) => marked(a, z, true))) fail(a.page, `no edge between ${from} and the lib box carries "breaks:", yet ${i.from} imports ${i.to}.`);
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
  `architecture map: ${levels.length} levels, ${boxes.length} boxes, ${edgeCount} edges, ${journeys.length} journeys, ${imports.length} imports read, ${attached.size} state machine pages on boxes, ${written.length} state machine pages, all in the index`,
);
