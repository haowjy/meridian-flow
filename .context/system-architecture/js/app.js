/*
 * The viewer: one page, one nav (System, Code, Server, App, Flows, State machines, Journeys,
 * Dependencies). The route is the URL hash:
 *   #<level>[/<box>]        a level page, as a Map or as Read (Markdown); the header toggles
 *   #flows[/<flow>]         #machines   #dependencies   #journeys[/<journey>[/<step>]]
 *   #doc/<path>[/<heading>] any .context page, full window over whatever was open
 * Every route is a history entry except choosing a box or step, so the browser's Back and the
 * Back button walk the same trail.
 */
import { createJourneys } from "./journeys.js";
import { createMap } from "./map.js";
import { isDocPath, loadFailure, paintMarkdown } from "./markdown.js";
import { item, linksOf, MAP_DIR, STATE_MACHINES_INDEX, resolveHref, sourceUrl } from "./pages.js";
import { currentTheme, el, fetchPage, fetchRepoFile, loadLevels, onThemeChange, pinTheme } from "./shell.js";

const root = document.getElementById("root");
const host = el("main", { class: "view" });
const MODE_KEY = "meridian-architecture-view";
const READ_PAGES = {
  flows: `${MAP_DIR}/flows/index.md`,
  machines: STATE_MACHINES_INDEX,
  dependencies: `${MAP_DIR}/dependencies.md`,
};

/** Level id → { id, title, path, page, parent }: the README's pages and the child pages their groups open. */
const levels = new Map();
let navLevels = [];
let mode = "map";
try {
  if (localStorage.getItem(MODE_KEY) === "read") mode = "read";
} catch {
  // No storage: Map for this visit.
}

// ---- Routes and history ----

function parseHash() {
  const [head, a, b] = location.hash.slice(1).split("/").map(decodeURIComponent);
  if (head === "doc") return { kind: "doc", path: a ?? "", fragment: b };
  if (head === "flows" && a) return { kind: "read", key: `flows/${a}`, path: `${MAP_DIR}/flows/${a}.md`, section: "flows" };
  if (head in READ_PAGES) return { kind: "read", key: head, path: READ_PAGES[head], section: head, fragment: a };
  if (head === "journeys") return { kind: "journeys", journey: a, step: b };
  const id = head || navLevels[0].id;
  return { kind: "level", id, box: a ?? null };
}

/** The history state: how many doc entries sit on top of the page the reader came from; `direct` when the first doc was opened with no page under it. */
const stateNow = () => history.state ?? { docs: 0, direct: location.hash.startsWith("#doc/") };

function go(hash, { replace = false } = {}) {
  if (hash === location.hash) return;
  const prev = stateNow();
  const state = hash.startsWith("#doc/") ? { docs: prev.docs + 1, direct: prev.direct } : { docs: 0, direct: false };
  history[replace ? "replaceState" : "pushState"](state, "", hash);
  render();
}
const nav = { go: (hash) => go(hash), replace: (hash) => go(hash, { replace: true }) };

const home = () => `#${navLevels[0].id}`;
/** Back: the previous doc, or the page the reader came from. */
const back = () => (stateNow().docs > 0 ? history.back() : go(home(), { replace: true }));
/** Close: the page the reader came from, past every doc opened since. */
const close = () => {
  const { docs, direct } = stateNow();
  if (docs > 0 && !direct) history.go(-docs);
  else go(home(), { replace: true });
};

document.addEventListener("click", (event) => {
  const link = event.target.closest?.("a[href^='#']");
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button || link.target) return;
  event.preventDefault();
  go(link.getAttribute("href"));
});
addEventListener("keydown", (event) => event.key === "Escape" && docView && close());
addEventListener("popstate", () => render());
addEventListener("hashchange", () => render());
onThemeChange(() => {
  baseKey = docKey = null;
  render();
});

// ---- The page under the nav ----

let seq = 0;
let baseKey = null;
let baseHash = null;
let base = null; // { update(route), dispose() }
let docView = null;
let docKey = null;

async function render() {
  const mine = ++seq;
  const r = parseHash();
  if (r.kind === "doc") {
    showDoc(r);
    return;
  }
  hideDoc();
  syncChrome(r);
  const key = r.kind === "level" ? `level:${r.id}:${mode}` : r.kind === "read" ? `read:${r.key}` : "journeys";
  if (key === baseKey) {
    // Closing a doc returns to the same hash: leave the page as the reader left it.
    if (location.hash !== baseHash) base?.update(r);
    baseHash = location.hash;
    return;
  }
  base?.dispose();
  base = null;
  baseKey = null;
  host.className = "view";
  try {
    const mounted = await mount(r);
    if (mine !== seq) return mounted.dispose();
    base = mounted;
    baseKey = key;
    baseHash = location.hash;
  } catch (error) {
    if (mine !== seq) return;
    host.replaceChildren(el("p", { class: "doc-note pad" }, `This page didn't load: ${error.message ?? error}`));
  }
}

async function mount(r) {
  if (r.kind === "journeys") {
    host.className = "view workspace";
    const journeys = await createJourneys(host, { nav });
    const update = (route) => journeys.select(route.journey, route.step);
    update(r);
    return { update, dispose: journeys.dispose };
  }
  if (r.kind === "level") {
    const level = levels.get(r.id);
    if (!level) throw new Error(`No map page called "${r.id}".`);
    if (mode === "map") {
      host.className = "view workspace";
      const map = await createMap(host, { page: level.page, path: level.path, parent: level.parent, nav });
      const update = (route) => map.select(route.box);
      update(r);
      return { update, dispose: map.dispose };
    }
    return mountRead(level.path, r.box);
  }
  return mountRead(r.path, r.fragment);
}

/** A page as Markdown, full width, diagrams inline; `target` is a heading id to scroll to. */
async function mountRead(path, target) {
  const article = el("article", { class: "md" });
  host.className = "view";
  const scroller = el("div", { class: "read" }, article);
  host.replaceChildren(scroller);
  const scrollTo = (id) => (id ? article.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: "start" }) : scroller.scrollTo(0, 0));
  try {
    await paintMarkdown(article, await fetchRepoFile(path), path, (holder, source) => wireDiagram(holder, source, scrollTo));
  } catch (error) {
    article.replaceChildren(loadFailure(path, error));
  }
  if (target) scrollTo(target);
  return { update: (route) => scrollTo(route.box ?? route.fragment), dispose() {} };
}

/** A box in a Read diagram scrolls to its section; a participant in a flow opens its box on the map. */
function wireDiagram(holder, source, scrollTo) {
  const click = (g, onclick, label) => {
    g.style.cursor = "pointer";
    g.setAttribute("tabindex", "0");
    g.setAttribute("role", "button");
    g.setAttribute("aria-label", label);
    g.addEventListener("click", onclick);
    g.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onclick()));
  };
  if (source.startsWith("sequenceDiagram")) {
    const known = new Set([...levels.values()].flatMap((l) => l.page.mermaid?.nodes.map((n) => n.id) ?? []));
    for (const actor of holder.querySelectorAll("rect.actor[name]")) {
      const id = actor.getAttribute("name");
      const level = known.has(id) && [...levels.values()].find((l) => l.page.mermaid?.nodes.some((n) => n.id === id && n.kind !== "context"));
      if (!level) continue;
      const group = actor.closest("g") ?? actor;
      click(group, () => openOnMap(level.id, id), `Open ${id} on the map`);
    }
    return;
  }
  for (const g of holder.querySelectorAll("g.node")) {
    const id = /flowchart-(.+)-\d+$/.exec(g.id)?.[1];
    if (id) click(g, () => scrollTo(id), `Go to ${id}`);
  }
}

function openOnMap(levelId, box) {
  mode = "map";
  saveMode();
  go(`#${levelId}/${encodeURIComponent(box)}`);
}

function saveMode() {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Not remembered; the choice still holds for this visit.
  }
}

// ---- The doc view: a .context page over the whole window ----

function showDoc({ path, fragment }) {
  if (!isDocPath(path)) {
    hideDoc();
    host.replaceChildren(el("p", { class: "doc-note pad" }, `${path} isn't a .context page.`));
    return;
  }
  const key = `${path}#${fragment ?? ""}`;
  if (docView && key === docKey) return;
  docKey = key;
  const article = el("article", { class: "md" });
  const scroll = el("div", { class: "doc-scroll" }, article);
  const title = el("strong", null, path);
  if (!docView) {
    docView = el(
      "div",
      { class: "doc-view", role: "dialog", "aria-label": "Page" },
      el(
        "div",
        { class: "doc-head" },
        el("button", { type: "button", class: "text-button", onclick: back }, "← Back"),
        el("div", { class: "doc-title" }, title, el("a", { class: "path", href: sourceUrl(path), target: "_blank", rel: "noreferrer" }, path)),
        el("button", { type: "button", class: "icon-button", "aria-label": "Close", title: "Close (Esc)", onclick: close }, "×"),
      ),
      scroll,
    );
    document.body.append(docView);
    docView.querySelector("button")?.focus();
  } else {
    docView.querySelector(".doc-scroll").replaceWith(scroll);
    const head = docView.querySelector(".doc-title");
    head.replaceChildren(title, el("a", { class: "path", href: sourceUrl(path), target: "_blank", rel: "noreferrer" }, path));
  }
  fetchRepoFile(path)
    .then(async (text) => (await paintMarkdown(article, text, path), text))
    .then((text) => {
      if (docKey !== key) return;
      title.textContent = /^# (.+)$/m.exec(text)?.[1] ?? path;
      const heading = fragment && article.querySelector(`#${CSS.escape(fragment)}`);
      if (heading) heading.scrollIntoView();
    })
    .catch((error) => docKey === key && article.replaceChildren(loadFailure(path, error)));
}

function hideDoc() {
  docView?.remove();
  docView = null;
  docKey = null;
}

// ---- The chrome ----

const chrome = {};

function buildChrome() {
  const links = [
    ...navLevels.map((l) => ({ section: l.id, href: `#${l.id}`, label: l.title })),
    { section: "flows", href: "#flows", label: "Flows" },
    { section: "machines", href: "#machines", label: "State machines" },
    { section: "journeys", href: "#journeys", label: "Journeys" },
    { section: "dependencies", href: "#dependencies", label: "Dependencies" },
  ];
  chrome.links = new Map(links.map((l) => [l.section, el("a", { href: l.href }, l.label)]));
  chrome.modes = ["read", "map"].map((m) => el("button", { type: "button", "data-mode": m, onclick: () => setMode(m) }, m === "read" ? "Read" : "Map"));
  chrome.toggle = el("div", { class: "segmented", role: "group", "aria-label": "View" }, chrome.modes);
  const theme = el("button", { type: "button", class: "text-button" });
  const sync = () => (theme.textContent = currentTheme() === "dark" ? "Light theme" : "Dark theme");
  theme.addEventListener("click", () => pinTheme(currentTheme() === "dark" ? "light" : "dark"));
  onThemeChange(sync);
  sync();
  return el("header", { class: "topbar" }, el("nav", { class: "levels", "aria-label": "Sections" }, [...chrome.links.values()]), chrome.toggle, theme);
}

function setMode(next) {
  if (next === mode) return;
  mode = next;
  saveMode();
  render();
}

/** The nav's current entry, and the Read | Map toggle on level pages. */
function syncChrome(r) {
  const section = r.kind === "level" ? (levels.get(r.id)?.parent?.section ?? r.id) : r.kind === "journeys" ? "journeys" : r.section;
  for (const [id, a] of chrome.links) {
    if (id === section) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  chrome.toggle.hidden = r.kind !== "level";
  for (const b of chrome.modes) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  document.title = `${r.kind === "level" ? (levels.get(r.id)?.page.title ?? r.id) : "Architecture"} · Meridian architecture`;
}

// ---- Start ----

/** Loads the README's pages and, through their groups' Opens, the child pages. */
async function loadLevelPages() {
  navLevels = await loadLevels();
  const queue = navLevels.map((l) => ({ ...l, parent: null }));
  while (queue.length) {
    const level = queue.shift();
    if (levels.has(level.id)) continue;
    level.page = await fetchPage(level.path);
    level.title = level.page.title;
    levels.set(level.id, level);
    for (const s of level.page.sections) {
      const opens = linksOf(item(s, "Opens")?.value ?? "")[0];
      const target = opens && resolveHref(level.path, opens.href).path;
      if (!target?.startsWith(`${MAP_DIR}/`) || !target.endsWith(".md")) continue;
      const id = target.slice(MAP_DIR.length + 1, -3);
      queue.push({ id, title: id, path: target, parent: { title: level.page.title, hash: `#${level.id}/${encodeURIComponent(s.id)}`, section: level.parent?.section ?? level.id } });
    }
  }
}

async function main() {
  await loadLevelPages();
  if (location.hash.startsWith("#doc/") && !history.state) history.replaceState(stateNow(), "");
  root.replaceChildren(buildChrome(), host);
  await render();
}

main().catch((error) => {
  root.replaceChildren(el("p", { class: "doc-note pad" }, `The map didn't load: ${error.message ?? error}`));
});
