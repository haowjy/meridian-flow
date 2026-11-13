/*
 * The map view of a level page: its Mermaid flowchart on a pan-and-zoom canvas under the page's
 * intro, and a side panel with the selected box's section. A box's own arrows stay lit and the
 * rest fade; a group opens its child page.
 */
import { drawDiagram, paintInline, route } from "./markdown.js";
import { item, linksOf, NODE_KINDS, pathsOf, sourceUrl } from "./pages.js";
import { el } from "./shell.js";

/**
 * Mermaid sizes boxes and spacing from these. Boxes get a larger font than arrow labels so a
 * dense level still reads at Fit; when the arrow labels would not read at Fit, the diagram is
 * laid out without them and a box's labels show when it is selected, an arrow's when hovered.
 */
const LOOK = { fontSize: 22, edgeFontSize: 16, flowchart: { nodeSpacing: 36, rankSpacing: 56, padding: 8, wrappingWidth: 260 } };
const LEGIBLE_EDGE_LABEL = 6;
/** Fit never draws box labels larger than 24px. */
const MAX_SCALE = 24 / LOOK.fontSize;
/** Fit keeps the diagram below the zoom buttons. */
const TOOLS_HEIGHT = 44;
/** Where along a line a tag may sit, in the order tried: the middle first. */
const ALONG = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88];

const plain = (label) => label.replace(/<br\s*\/?>.*$/, "").replace(/<[^>]+>/g, "");
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Mounts the map of `page` (parsed, at repo `path`) into `host`. `nav.go(hash)` opens another
 * route; `nav.replace(hash)` changes the address without a history entry. `parent` is the box
 * that opens this page, if any: { title, hash }. Returns { select(id), dispose() }.
 */
export async function createMap(host, { page, path, parent, nav }) {
  const zoom = { x: 0, y: 0, k: 1 };
  let selected = null;
  let hovered = null;
  let stage = null;
  let labelled = true;
  let userZoomed = false;
  const tags = el("div", { class: "edge-tags", "aria-hidden": "true" });
  const diagram = el("div", { class: "diagram", id: "map-diagram" });
  const panel = el("aside", { class: "panel", "aria-label": "Selected box" });
  const canvas = el("div", { class: "canvas" }, intro(), diagram);
  host.replaceChildren(canvas, panel);

  // ---- The canvas ----

  function intro() {
    const text = el("p", { class: "intro-text is-clamped" });
    paintInline(text, page.intro, path);
    const more = el("button", { type: "button", class: "link-button more", onclick: () => more.textContent = text.classList.toggle("is-clamped") ? "Read more" : "Show less" }, "Read more");
    return el(
      "details",
      { class: "intro", open: !matchMedia("(max-width: 719px)").matches },
      el("summary", null, el("strong", null, page.title), parent && el("a", { class: "up", href: parent.hash }, `↑ ${parent.title}`)),
      text,
      more,
      el(
        "p",
        { class: "how-to" },
        el("strong", null, "How to read this: "),
        "numbered arrows are the main path, in order; the rest are side trips. Click a box for detail; a box with a stacked edge is a group and opens its own page. Drag to pan, scroll to zoom.",
      ),
    );
  }

  const viewBoxOf = (svg) => {
    const [, , width, height] = /viewBox="([^"]+)"/.exec(svg)[1].split(/[\s,]+/).map(Number);
    return { width, height };
  };

  function fitScale({ width, height }) {
    const r = diagram.getBoundingClientRect();
    return Math.min(r.width / width, (r.height - TOOLS_HEIGHT) / height, MAX_SCALE) * 0.96;
  }

  function applyZoom() {
    stage.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.k})`;
    placeTags();
  }

  function fit() {
    if (!stage) return;
    userZoomed = false;
    const box = stage.querySelector("svg").viewBox.baseVal;
    const { width, height } = diagram.getBoundingClientRect();
    zoom.k = fitScale(box);
    zoom.x = (width - box.width * zoom.k) / 2;
    zoom.y = TOOLS_HEIGHT + (height - TOOLS_HEIGHT - box.height * zoom.k) / 2;
    applyZoom();
  }

  function zoomBy(factor, cx, cy) {
    userZoomed = true;
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
      userZoomed = true;
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
      if (selected && !event.target.closest("g.node, .diagram-tools, .legend")) choose(null);
    });
  }

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

  const legend = () => {
    const kinds = NODE_KINDS.filter((kind) => page.mermaid.nodes.some((n) => n.kind === kind));
    return el("details", { class: "legend" }, el("summary", null, "Legend"), el("ul", null, kinds.map((kind) => el("li", null, el("span", { class: `swatch kind-${kind}` }), kind))));
  };

  async function draw() {
    const { mermaid } = page;
    if (!mermaid) {
      diagram.replaceChildren(el("p", { class: "doc-note" }, `${path} has no mermaid block.`));
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
    diagram.replaceChildren(stage, tags, tools(), legend());
    annotate();
    fit();
  }

  /** Marks the arrows numbered or not and wires the boxes' clicks. Mermaid names an edge's elements `L_<from>_<to>_<n>`. */
  function annotate() {
    const { nodes, edges } = page.mermaid;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const g of stage.querySelectorAll("g.node")) {
      const id = /flowchart-(.+)-\d+$/.exec(g.id)?.[1];
      if (!byId.has(id)) continue;
      g.dataset.id = id;
      g.setAttribute("tabindex", "0");
      g.setAttribute("role", "button");
      g.setAttribute("aria-label", plain(byId.get(id).label));
      g.addEventListener("click", () => choose(id));
      g.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), choose(id)));
    }
    // The elements of each edge, by Mermaid's data-id. Several edges between one pair are numbered
    // with gaps (_0, _2), so the k-th edge of a pair takes the k-th lowest number.
    const lines = new Map();
    for (const node of stage.querySelectorAll("path.flowchart-link[data-id], g.edgeLabel g.label[data-id]")) {
      const holder = node.tagName === "path" ? node : node.closest("g.edgeLabel");
      lines.set(node.dataset.id, [...(lines.get(node.dataset.id) ?? []), holder]);
    }
    const seen = new Map();
    edges.forEach((edge, i) => {
      const pair = `L_${edge.from}_${edge.to}_`;
      const numbers = [...lines.keys()].filter((key) => key.startsWith(pair) && /^\d+$/.test(key.slice(pair.length))).map((key) => Number(key.slice(pair.length))).sort((x, y) => x - y);
      const k = seen.get(pair) ?? 0;
      seen.set(pair, k + 1);
      const elements = lines.get(`${pair}${numbers[k]}`) ?? [];
      const path = elements.find((e) => e.tagName === "path");
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
      for (const node of elements) {
        if (edge.step !== null) node.classList.add("edge-step");
        node.dataset.i = i;
      }
    });
  }

  // ---- Selection ----

  /** A click on a box: a group opens its page, any other box is selected (and put in the address). */
  function choose(id) {
    const node = page.mermaid.nodes.find((n) => n.id === id);
    const opens = node?.kind === "group" && opensOf(id);
    if (opens) return nav.go(opens);
    nav.replace(id ? `${location.hash.split("/")[0]}/${encodeURIComponent(id)}` : location.hash.split("/")[0]);
    select(id);
  }

  function opensOf(id) {
    const section = page.sections.find((s) => s.id === id);
    const link = linksOf(item(section, "Opens")?.value ?? "")[0];
    return link && route(path, link.href)?.href;
  }

  const isLinked = (edge) => selected != null && (edge.from === selected || edge.to === selected);

  function markSelected() {
    if (!stage) return;
    const { edges } = page.mermaid;
    const neighbours = new Set(edges.filter(isLinked).flatMap((e) => [e.from, e.to]));
    stage.classList.toggle("has-selection", selected != null);
    for (const g of stage.querySelectorAll("g.node")) {
      g.classList.toggle("is-selected", g.dataset.id === selected);
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

  /** Stage coordinates of a point given in screen coordinates. */
  function toStage(point) {
    const r = diagram.getBoundingClientRect();
    return { x: (point.x - r.left - zoom.x) / zoom.k, y: (point.y - r.top - zoom.y) / zoom.k };
  }

  /** On an unlabelled diagram, the labels of the selected box's arrows and of the hovered arrow, each on its own line. */
  function showTags() {
    if (!stage) return;
    const { edges } = page.mermaid;
    const shown = labelled ? [] : edges.flatMap((edge, i) => (isLinked(edge) || i === hovered ? [i] : []));
    tags.replaceChildren(
      ...shown.map((i) => {
        const tag = el("span", { class: `edge-tag${edges[i].step !== null ? " edge-step" : ""}` }, edges[i].label);
        tag.i = i;
        const line = stage.querySelector(`path.flowchart-link[data-i="${i}"]`);
        const length = line?.getTotalLength();
        if (length) tag.along = ALONG.map((t) => toStage(line.getPointAtLength(length * t).matrixTransform(line.getScreenCTM())));
        return tag;
      }),
    );
    placeTags();
  }

  /**
   * Puts each tag on screen at the first point along its line, or just above or below it, where it
   * covers neither a lit box nor another tag. A tag with no such spot stays hidden (the panel lists
   * every connection), except the hovered arrow's, which goes first and shows wherever it covers least.
   */
  function placeTags() {
    if (!stage) return;
    const r = diagram.getBoundingClientRect();
    const edge = page.mermaid.edges[hovered];
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
    selected = id;
    markSelected();
    panel.replaceChildren(id ? boxPanel(id) : overview());
    panel.scrollTop = 0;
  }

  function paragraph(markdown, className) {
    const p = el("p", { class: className });
    paintInline(p, markdown, path);
    return p;
  }

  /** Nothing selected: the boxes of this page, each with its one-line role, as a way in. */
  function overview() {
    return el(
      "div",
      { class: "panel-body" },
      el("h2", null, "Boxes on this page"),
      el(
        "ul",
        { class: "box-list" },
        page.mermaid.nodes.map((n) => {
          const section = page.sections.find((s) => s.id === n.id);
          return el(
            "li",
            null,
            el("button", { type: "button", class: "link-button", onclick: () => choose(n.id) }, plain(n.label), n.kind === "group" ? " ▸" : ""),
            section?.paragraphs[0] && paragraph(section.paragraphs[0], "sub-line"),
          );
        }),
      ),
    );
  }

  function boxPanel(id) {
    const section = page.sections.find((s) => s.id === id);
    const node = page.mermaid.nodes.find((n) => n.id === id);
    if (!section || !node) return el("div", { class: "panel-body" }, el("p", { class: "doc-note" }, `No box "${id}" on this page.`));
    const [sub, ...about] = section.paragraphs;
    const value = (key) => item(section, key)?.value;
    const paths = pathsOf(value("Paths") ?? "");
    return el("div", { class: "panel-body" }, [
      el("button", { type: "button", class: "link-button back", onclick: () => choose(null) }, "← All boxes"),
      el("div", { class: "panel-head" }, el("h2", null, plain(node.label)), el("span", { class: `chip kind-${node.kind}` }, node.kind)),
      sub && paragraph(sub, "sub"),
      ...about.map((text) => paragraph(text)),
      ...section.items
        .filter((it) => it.key === "Breaks" || it.key === "Drift")
        .map((it) => el("div", { class: `callout is-${it.key.toLowerCase()}` }, el("strong", null, it.key === "Breaks" ? "Breaks a rule: " : "Docs and code disagree: "), inline(it.value))),
      paths.length ? el("section", null, el("h3", null, "Paths"), el("ul", { class: "paths" }, paths.map((p) => el("li", null, el("a", { class: "path", href: sourceUrl(p), target: "_blank", rel: "noreferrer" }, p))))) : null,
      connections(id),
      links("See", value("See")),
      links("Opens", value("Opens")),
      links("Machines", value("Machines")),
      links("Docs", value("Docs")),
    ]);
  }

  function inline(markdown) {
    const span = el("span");
    paintInline(span, markdown, path);
    return span;
  }

  function links(heading, value) {
    const list = linksOf(value ?? "");
    if (!list.length) return null;
    return el(
      "section",
      null,
      el("h3", null, heading),
      el("ul", null, list.map((l) => {
        const to = route(path, l.href);
        return el("li", null, el("a", { href: to?.href ?? l.href, target: to?.external ? "_blank" : null, rel: to?.external ? "noreferrer" : null }, l.label));
      })),
    );
  }

  function connections(id) {
    const { nodes, edges } = page.mermaid;
    const label = (nid) => plain(nodes.find((n) => n.id === nid)?.label ?? nid);
    const rows = [];
    for (const e of edges) {
      if (e.from !== id && e.to !== id) continue;
      const other = e.from === id ? e.to : e.from;
      const arrow = e.both ? "↔" : e.from === id ? "→" : "←";
      rows.push(el("li", null, `${arrow} `, el("button", { type: "button", class: "link-button", onclick: () => choose(other) }, label(other)), el("div", { class: "edge-label" }, e.label)));
    }
    return rows.length ? el("section", null, el("h3", null, "Arrows"), el("ul", { class: "edges" }, rows)) : null;
  }

  const resizer = new ResizeObserver(() => stage && !userZoomed && fit());
  resizer.observe(diagram);
  enablePanZoom();
  await draw();
  select(null);

  return {
    select(id) {
      if (id !== selected) select(id);
    },
    dispose() {
      resizer.disconnect();
    },
  };
}
