/*
 * The map viewer: fetches a level page (README.md lists them), draws its Mermaid flowchart with
 * pan and zoom, and opens a box's section in the side panel. The URL hash is `#<page>/<id>`.
 */
import { drawDiagram, initDocView, openDoc, paintInline, route, showPage } from "./doc-view.js";
import { EDGE_KINDS, item, linksOf, MAP_DIR, NODE_KINDS, pathsOf, resolveHref, sourceUrl } from "./pages.js";
import { el, fetchPage, loadLevels, onThemeChange, topBar } from "./shell.js";

const INDEX = ".context/state-machines/index.md";

const view = { levels: [], page: null, path: null, selected: null };
const diagram = el("div", { class: "diagram", id: "map-diagram" });
const panel = el("aside", { class: "panel", "aria-label": "Selected box" });
const workspace = el("div", { class: "workspace" }, diagram, panel);
const app = document.getElementById("app");

const parseHash = () => {
  const [page, id] = location.hash.slice(1).split("/");
  return { page: page || view.levels[0]?.id, id: id ? decodeURIComponent(id) : null };
};

async function main() {
  view.levels = await loadLevels();
  app.replaceChildren(topBar({ current: null, levels: view.levels, onMachines: () => openDoc(INDEX) }), workspace);
  initDocView(workspace);
  addEventListener("hashchange", route_);
  onThemeChange(() => view.page && draw());
  await route_();
}

let loading = null;
async function route_() {
  const { page, id } = parseHash();
  const level = view.levels.find((l) => l.id === page);
  if (!level) {
    diagram.replaceChildren(el("p", { class: "doc-note" }, `No map page called "${page}".`));
    return;
  }
  for (const a of document.querySelectorAll(".levels a")) {
    a.toggleAttribute("aria-current", a.getAttribute("href") === `index.html#${page}`);
    if (a.hasAttribute("aria-current")) a.setAttribute("aria-current", "page");
  }
  if (view.path !== level.path) {
    view.path = level.path;
    view.selected = null;
    loading = fetchPage(level.path);
    try {
      view.page = await loading;
    } catch (error) {
      diagram.replaceChildren(el("p", { class: "doc-note" }, `Couldn't load ${level.path}: ${error.message}`));
      return;
    }
    if (view.path !== level.path) return;
    await draw();
  }
  select(id);
}

// ---- The diagram ----

const zoom = { x: 0, y: 0, k: 1 };
let stage = null;

function applyZoom() {
  stage.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.k})`;
}

function fit() {
  const svg = stage.querySelector("svg");
  const box = svg.viewBox.baseVal;
  const { width, height } = diagram.getBoundingClientRect();
  zoom.k = Math.min(width / box.width, height / box.height, 1.5) * 0.96;
  zoom.x = (width - box.width * zoom.k) / 2;
  zoom.y = (height - box.height * zoom.k) / 2;
  applyZoom();
}

function zoomBy(factor, cx, cy) {
  const k = Math.min(Math.max(zoom.k * factor, 0.1), 4);
  zoom.x = cx - ((cx - zoom.x) * k) / zoom.k;
  zoom.y = cy - ((cy - zoom.y) * k) / zoom.k;
  zoom.k = k;
  applyZoom();
}

function enablePanZoom() {
  let drag = null;
  diagram.addEventListener("wheel", (event) => {
    event.preventDefault();
    const r = diagram.getBoundingClientRect();
    zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX - r.left, event.clientY - r.top);
  }, { passive: false });
  diagram.addEventListener("pointerdown", (event) => {
    if (event.button || event.target.closest(".diagram-tools")) return;
    drag = { x: event.clientX, y: event.clientY, moved: false };
  });
  diagram.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) diagram.setPointerCapture(event.pointerId);
    drag.moved = true;
    zoom.x += dx;
    zoom.y += dy;
    drag.x = event.clientX;
    drag.y = event.clientY;
    applyZoom();
  });
  const end = () => {
    // The click that follows a drag must not select what the drag ended on.
    if (drag?.moved) diagram.addEventListener("click", (e) => e.stopPropagation(), { capture: true, once: true });
    drag = null;
  };
  diagram.addEventListener("pointerup", end);
  diagram.addEventListener("pointercancel", end);
}

enablePanZoom();

const tools = () => {
  const center = () => [diagram.clientWidth / 2, diagram.clientHeight / 2];
  return el(
    "div",
    { class: "diagram-tools" },
    el("button", { type: "button", class: "text-button", "aria-label": "Zoom in", onclick: () => zoomBy(1.3, ...center()) }, "+"),
    el("button", { type: "button", class: "text-button", "aria-label": "Zoom out", onclick: () => zoomBy(1 / 1.3, ...center()) }, "−"),
    el("button", { type: "button", class: "text-button", onclick: fit }, "Fit"),
  );
};

const legend = () =>
  el(
    "details",
    { class: "legend" },
    el("summary", null, "Legend"),
    el("p", null, "Boxes"),
    el("ul", null, NODE_KINDS.map((kind) => el("li", null, el("span", { class: `swatch kind-${kind}` }), kind))),
    el("p", null, "Arrows (from the side that starts the exchange)"),
    el("ul", null, EDGE_KINDS.map((kind) => el("li", null, el("span", { class: `line edge-${kind}` }), kind))),
  );

async function draw() {
  const keep = stage ? { ...zoom } : null;
  const { mermaid } = view.page;
  if (!mermaid) {
    diagram.replaceChildren(el("p", { class: "doc-note" }, `${view.path} has no mermaid block.`));
    return;
  }
  let svg;
  try {
    svg = await drawDiagram(mermaid.source);
  } catch (error) {
    diagram.replaceChildren(el("p", { class: "doc-note" }, `This diagram didn't draw: ${error.message ?? error}`));
    return;
  }
  stage = el("div", { class: "stage" });
  stage.innerHTML = svg;
  diagram.replaceChildren(stage, tools(), legend());
  annotate();
  if (keep) {
    Object.assign(zoom, keep);
    applyZoom();
  } else fit();
  markSelected();
}

/** Classes the edges by kind and wires the boxes' clicks. Mermaid draws edges in the order written. */
function annotate() {
  const { nodes, edges } = view.page.mermaid;
  const ids = new Set(nodes.map((n) => n.id));
  for (const g of stage.querySelectorAll("g.node")) {
    const id = /flowchart-(.+)-\d+$/.exec(g.id)?.[1];
    if (!ids.has(id)) continue;
    g.dataset.id = id;
    g.setAttribute("tabindex", "0");
    g.setAttribute("role", "button");
    g.addEventListener("click", () => go(id));
    g.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), go(id)));
  }
  const paths = stage.querySelectorAll("path.flowchart-link");
  const labels = stage.querySelectorAll("g.edgeLabel");
  edges.forEach((edge, i) => {
    for (const node of [paths[i], labels[i]]) {
      if (!node) continue;
      node.classList.add(`edge-${edge.kind}`);
      node.dataset.from = edge.from;
      node.dataset.to = edge.to;
      if (edge.label.includes("breaks:")) node.classList.add("edge-breaks");
    }
  });
}

const go = (id) => {
  location.hash = `${parseHash().page}/${encodeURIComponent(id)}`;
};

function markSelected() {
  stage?.classList.toggle("has-selection", view.selected != null);
  for (const g of stage?.querySelectorAll("g.node") ?? []) g.classList.toggle("is-selected", g.dataset.id === view.selected);
  for (const e of stage?.querySelectorAll("[data-from]") ?? [])
    e.classList.toggle("is-linked", view.selected != null && (e.dataset.from === view.selected || e.dataset.to === view.selected));
}

// ---- The panel ----

function select(id) {
  view.selected = id;
  markSelected();
  panel.replaceChildren(id ? boxPanel(id) : intro());
  panel.scrollTop = 0;
}

const intro = () =>
  el(
    "div",
    { class: "panel-body" },
    el("h2", null, view.page.title),
    paragraph(view.page.intro),
    el("p", { class: "panel-hint" }, "Click a box. Drag to pan, scroll to zoom."),
  );

function paragraph(markdown, className) {
  const p = el("p", { class: className });
  paintInline(p, markdown, view.path);
  return p;
}

const mapHash = (href) => {
  const { path, fragment } = resolveHref(view.path, href);
  const m = path && new RegExp(`^${MAP_DIR.replaceAll(".", "\\.")}/([\\w-]+)\\.md$`).exec(path);
  return m ? `#${m[1]}${fragment ? `/${fragment}` : ""}` : null;
};

function boxPanel(id) {
  const section = view.page.sections.find((s) => s.id === id);
  const node = view.page.mermaid.nodes.find((n) => n.id === id);
  if (!section || !node) return el("div", { class: "panel-body" }, el("p", { class: "doc-note" }, `No box "${id}" on this page.`));
  const [sub, ...about] = section.paragraphs;
  const value = (key) => item(section, key)?.value;
  const paths = pathsOf(value("Paths") ?? "");
  const kids = [
    el("div", { class: "panel-head" }, el("h2", null, node.label.replace(/<br\s*\/?>/g, " ")), el("span", { class: `chip kind-${node.kind}` }, node.kind)),
    sub && paragraph(sub, "sub"),
    ...about.map((text) => paragraph(text)),
    ...section.items
      .filter((it) => it.key === "Breaks" || it.key === "Drift")
      .map((it) =>
        el("div", { class: `callout is-${it.key.toLowerCase()}` }, el("strong", null, it.key === "Breaks" ? "Breaks a rule: " : "Docs and code disagree: "), inline(it.value)),
      ),
    paths.length ? el("section", null, el("h3", null, "Paths"), el("ul", { class: "paths" }, paths.map((p) => el("li", null, el("a", { class: "path", href: sourceUrl(p), target: "_blank", rel: "noreferrer" }, p))))) : null,
    connections(id),
    links("See", value("See"), mapHash),
    links("Opens", value("Opens"), mapHash),
    pageDetails("Machines", value("Machines")),
    pageDetails("Docs", value("Docs")),
  ];
  return el("div", { class: "panel-body" }, kids);
}

function inline(markdown) {
  const span = el("span");
  paintInline(span, markdown, view.path);
  return span;
}

function links(heading, value, hashOf) {
  if (!value) return null;
  return el(
    "section",
    null,
    el("h3", null, heading),
    el("ul", null, linksOf(value).map((l) => {
      const hash = hashOf(l.href);
      return el("li", null, hash ? el("a", { href: `index.html${hash}` }, l.label) : el("a", { href: route(view.path, l.href)?.href ?? l.href }, l.label));
    })),
  );
}

function connections(id) {
  const { nodes, edges } = view.page.mermaid;
  const label = (nid) => nodes.find((n) => n.id === nid)?.label.replace(/<br\s*\/?>/g, " ") ?? nid;
  const rows = [];
  for (const e of edges) {
    if (e.from !== id && e.to !== id) continue;
    const other = e.from === id ? e.to : e.from;
    const arrow = e.both ? "↔" : e.from === id ? "→" : "←";
    rows.push(
      el("li", null, el("span", { class: `edge-kind edge-${e.kind}` }, e.kind), ` ${arrow} `, el("a", { href: `#${parseHash().page}/${encodeURIComponent(other)}` }, label(other)), el("div", { class: "edge-label" }, e.label.replace(/^\w+: ?/, ""))),
    );
  }
  return rows.length ? el("section", null, el("h3", null, "Connections"), el("ul", { class: "edges" }, rows)) : null;
}

/** Collapsed pages: each link's Markdown is fetched and drawn the first time it opens. */
function pageDetails(heading, value) {
  if (!value) return null;
  const pages = linksOf(value);
  if (!pages.length) return null;
  return el(
    "section",
    null,
    el("h3", null, heading),
    pages.map((l) => {
      const { path } = resolveHref(view.path, l.href);
      const body = el("article", { class: "md" });
      const details = el("details", { class: "page" }, el("summary", null, l.label), body);
      details.addEventListener("toggle", () => details.open && !body.hasChildNodes() && showPage(body, path), { once: false });
      return details;
    }),
  );
}

main().catch((error) => {
  app.replaceChildren(el("p", { class: "doc-note", style: "padding: 24px" }, `The map didn't load: ${error.message ?? error}`));
});
