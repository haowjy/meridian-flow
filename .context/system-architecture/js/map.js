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
  onThemeChange(() => view.page && draw({ keepZoom: true }));
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

/**
 * Mermaid sizes boxes and spacing from these. Boxes get a larger font than edge labels so a
 * dense level still reads at Fit; when the edge labels would not read at Fit, the diagram is
 * laid out without them (they double a dense level's size) and a box's labels show when it is
 * selected, an edge's when it is hovered.
 */
const LOOK = { fontSize: 24, edgeFontSize: 12, flowchart: { nodeSpacing: 24, rankSpacing: 36, padding: 6, wrappingWidth: 320 } };
const LEGIBLE_EDGE_LABEL = 7;
/** Fit never draws box labels larger than 18px. */
const MAX_SCALE = 18 / LOOK.fontSize;
/** Fit keeps the diagram below the zoom buttons. */
const TOOLS_HEIGHT = 44;

const zoom = { x: 0, y: 0, k: 1 };
let stage = null;
let labelled = true;
let hovered = null;
const tags = el("div", { class: "edge-tags", "aria-hidden": "true" });

function applyZoom() {
  stage.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.k})`;
  placeTags();
}

const viewBoxOf = (svg) => {
  const [, , width, height] = /viewBox="([^"]+)"/.exec(svg)[1].split(/[\s,]+/).map(Number);
  return { width, height };
};

function fitScale({ width, height }) {
  const r = diagram.getBoundingClientRect();
  return Math.min(r.width / width, (r.height - TOOLS_HEIGHT) / height, MAX_SCALE) * 0.96;
}

function fit() {
  const box = stage.querySelector("svg").viewBox.baseVal;
  const { width, height } = diagram.getBoundingClientRect();
  zoom.k = fitScale(box);
  zoom.x = (width - box.width * zoom.k) / 2;
  zoom.y = TOOLS_HEIGHT + (height - TOOLS_HEIGHT - box.height * zoom.k) / 2;
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
    if (event.button || event.target.closest(".diagram-tools, .legend")) return;
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
  diagram.addEventListener("click", (event) => {
    if (view.selected && !event.target.closest("g.node, .diagram-tools, .legend")) go(null);
  });
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
    el(
      "ul",
      null,
      EDGE_KINDS.map((kind) => el("li", null, el("span", { class: `line edge-${kind}` }), kind)),
      el("li", null, el("span", { class: "line edge-breaks" }), "breaks a rule"),
    ),
  );

/** Draws the page's diagram. `keepZoom` redraws in place (a theme change); otherwise it fits. */
async function draw({ keepZoom = false } = {}) {
  const { mermaid } = view.page;
  if (!mermaid) {
    diagram.replaceChildren(el("p", { class: "doc-note" }, `${view.path} has no mermaid block.`));
    return;
  }
  let svg;
  try {
    svg = await drawDiagram(mermaid.source, LOOK);
    labelled = fitScale(viewBoxOf(svg)) * LOOK.edgeFontSize >= LEGIBLE_EDGE_LABEL;
    if (!labelled) svg = await drawDiagram(mermaid.source.replace(/\|"[^"]*"\| /g, ""), LOOK);
  } catch (error) {
    diagram.replaceChildren(el("p", { class: "doc-note" }, `This diagram didn't draw: ${error.message ?? error}`));
    return;
  }
  stage = el("div", { class: `stage${labelled ? "" : " is-unlabelled"}` });
  stage.innerHTML = svg;
  hovered = null;
  diagram.replaceChildren(stage, tags, tools(), legend());
  annotate();
  if (keepZoom) applyZoom();
  else fit();
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
    const path = paths[i];
    if (!path) return;
    // A wide invisible copy of the line, so a thin edge is easy to hover.
    const hit = path.cloneNode(false);
    hit.removeAttribute("id");
    hit.removeAttribute("marker-end");
    hit.removeAttribute("marker-start");
    hit.setAttribute("class", "edge-hit");
    hit.addEventListener("pointerenter", () => hover(i));
    hit.addEventListener("pointerleave", () => hover(null));
    path.after(hit);
    for (const node of [path, labels[i]]) {
      if (!node) continue;
      node.classList.add(`edge-${edge.kind}`);
      node.dataset.i = i;
      node.dataset.from = edge.from;
      node.dataset.to = edge.to;
      if (edge.label.includes("breaks:")) node.classList.add("edge-breaks");
    }
  });
}

const go = (id) => {
  const page = parseHash().page;
  location.hash = id ? `${page}/${encodeURIComponent(id)}` : page;
};

const isLinked = (edge) => view.selected != null && (edge.from === view.selected || edge.to === view.selected);

function markSelected() {
  if (!stage) return;
  const { edges } = view.page.mermaid;
  const neighbours = new Set(edges.filter(isLinked).flatMap((e) => [e.from, e.to]));
  stage.classList.toggle("has-selection", view.selected != null);
  for (const g of stage.querySelectorAll("g.node")) {
    g.classList.toggle("is-selected", g.dataset.id === view.selected);
    g.classList.toggle("is-linked", neighbours.has(g.dataset.id));
  }
  for (const e of stage.querySelectorAll("[data-i]")) e.classList.toggle("is-linked", isLinked(edges[e.dataset.i]));
  showTags();
}

function hover(i) {
  hovered = i;
  for (const e of stage.querySelectorAll("[data-i]")) e.classList.toggle("is-hovered", Number(e.dataset.i) === i);
  showTags();
}

/** Where along a line a tag may sit, in the order tried: the middle first. */
const ALONG = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88];

/** Stage coordinates of a point given in screen coordinates. */
function toStage(point) {
  const r = diagram.getBoundingClientRect();
  return { x: (point.x - r.left - zoom.x) / zoom.k, y: (point.y - r.top - zoom.y) / zoom.k };
}

/**
 * On an unlabelled diagram, the labels of the selected box's edges and of the hovered edge, each
 * on its own line. The "(breaks: …)" note is left to the tag's colour and the panel.
 */
function showTags() {
  const { edges } = view.page.mermaid;
  const shown = labelled ? [] : edges.flatMap((edge, i) => (isLinked(edge) || i === hovered ? [i] : []));
  tags.replaceChildren(
    ...shown.map((i) => {
      const edge = edges[i];
      const breaks = edge.label.includes("breaks:");
      const tag = el("span", { class: `edge-tag edge-${edge.kind}${breaks ? " edge-breaks" : ""}` }, edge.label.replace(/\s*\(breaks:[^)]*\)$/, ""));
      tag.i = i;
      const path = stage.querySelector(`path.flowchart-link[data-i="${i}"]`);
      const length = path?.getTotalLength();
      if (length) tag.along = ALONG.map((t) => toStage(path.getPointAtLength(length * t).matrixTransform(path.getScreenCTM())));
      return tag;
    }),
  );
  placeTags();
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Puts each tag on screen at the first point along its line, or just above or below it, where it
 * covers neither a lit box nor another tag. A tag with no such spot stays hidden (the panel lists
 * every connection), except the hovered edge's, which goes first and shows wherever it covers least.
 */
function placeTags() {
  const r = diagram.getBoundingClientRect();
  const edge = view.page.mermaid.edges[hovered];
  const lit = (g) => g.matches(".is-selected, .is-linked") || g.dataset.id === edge?.from || g.dataset.id === edge?.to;
  const boxes = [...stage.querySelectorAll("g.node")].filter(lit).map((g) => {
    const b = g.getBoundingClientRect();
    return { x: b.left - r.left - 2, y: b.top - r.top - 2, w: b.width + 4, h: b.height + 4 };
  });
  const placed = [];
  const list = [...tags.children].filter((t) => t.along).sort((a, b) => (b.i === hovered) - (a.i === hovered));
  for (const tag of list) {
    tag.hidden = false;
    const w = tag.offsetWidth;
    const h = tag.offsetHeight;
    let best = null;
    search: for (const p of tag.along) {
      for (const dy of [0, -h / 2 - 3, h / 2 + 3, -h - 4, h + 4]) {
        const box = { x: zoom.x + p.x * zoom.k - w / 2, y: zoom.y + p.y * zoom.k - h / 2 + dy, w, h };
        const cost = 10 * boxes.filter((b) => overlaps(box, b)).length + placed.filter((b) => overlaps(box, b)).length;
        if (!best || cost < best.cost) best = { box, cost };
        if (!cost) break search;
      }
    }
    if (best.cost && tag.i !== hovered) {
      tag.hidden = true;
      continue;
    }
    placed.push(best.box);
    tag.style.transform = `translate(${best.box.x}px, ${best.box.y}px)`;
  }
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
      el("li", null, el("span", { class: `edge-kind edge-${e.kind}` }, e.kind), ` ${arrow} `, el("a", { href: `#${parseHash().page}/${encodeURIComponent(other)}` }, label(other)), el("div", { class: "edge-label" }, e.label)),
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
