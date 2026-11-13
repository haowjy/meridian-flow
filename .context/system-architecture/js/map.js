/*
 * The map view of a level page: its flowchart drawn with React Flow under the page's intro, and a
 * side panel with the selected box's section. A box's own arrows stay lit and the rest fade; a
 * group opens its child page. Boxes drag and the arrows follow; where they were put is remembered
 * for this page on this computer.
 */
import { paintInline, route } from "./markdown.js";
import { layoutFor } from "./layout.js";
import { item, linksOf, NODE_KINDS, pathsOf, sourceUrl } from "./pages.js";
import { el } from "./shell.js";

const React = globalThis.React;
const h = React.createElement;
const RF = globalThis.ReactFlow;
const { createContext, useContext, useEffect, useMemo, useRef, useState } = React;

/** Below this scale box text is unreadable, so a big level opens at its top, readable, to pan. */
const MIN_FIT_ZOOM = 0.4;
const LAYOUT_KEY = "meridian-architecture-layout:";

const parts = (label) => {
  const [name, ...role] = label.split(/<br\s*\/?>/);
  const text = (html) => html.replace(/<[^>]+>/g, "");
  return { name: text(name), role: text(role.join(" ")) };
};
const plain = (label) => parts(label).name;

/** Where the reader dragged this page's boxes: { id: { x, y } }, or {} (no storage, or nothing saved). */
function savedLayout(path) {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_KEY + path) ?? "{}");
  } catch {
    return {};
  }
}

function saveLayout(path, positions) {
  try {
    if (positions) localStorage.setItem(LAYOUT_KEY + path, JSON.stringify(positions));
    else localStorage.removeItem(LAYOUT_KEY + path);
  } catch {
    // Not remembered; the boxes stay where they are for this visit.
  }
}

/** What a box needs to draw itself that isn't in its node: the selection and what a click does. */
const Selection = createContext({ selectedId: null, linked: new Set() });

const SIDES = {
  LR: { target: RF.Position.Left, source: RF.Position.Right },
  TB: { target: RF.Position.Top, source: RF.Position.Bottom },
};

function Box({ data, id }) {
  const { selectedId, linked } = useContext(Selection);
  const { node, direction } = data;
  const side = SIDES[direction];
  const { name, role } = parts(node.label);
  const state = selectedId === null ? "" : id === selectedId ? "is-selected" : linked.has(id) ? "is-linked" : "is-dim";
  return h(
    "div",
    { className: `card kind-${node.kind} ${state}`, title: node.kind === "group" ? "Opens its own page" : undefined },
    h(RF.Handle, { type: "target", position: side.target, isConnectable: false }),
    h("div", { className: "card-label" }, name, node.kind === "group" ? " ▸" : ""),
    role ? h("div", { className: "card-sub" }, role) : null,
    h(RF.Handle, { type: "source", position: side.source, isConnectable: false }),
  );
}

function Note({ data, id }) {
  const { selectedId, linked } = useContext(Selection);
  const side = SIDES[data.direction];
  return h(
    "div",
    { className: `note-card ${selectedId !== null && !linked.has(id) ? "is-dim" : ""}` },
    h(RF.Handle, { type: "target", position: side.target, isConnectable: false }),
    parts(data.node.label).name,
    h(RF.Handle, { type: "source", position: side.source, isConnectable: false }),
  );
}

const nodeTypes = { box: Box, note: Note };

/** The arrowheads every edge refers to by id, coloured from tokens by CSS. */
function Markers() {
  const arrow = (id) =>
    h(
      "marker",
      { key: id, id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse", markerUnits: "strokeWidth" },
      h("path", { d: "M0,0 L10,5 L0,10 Z", className: id }),
    );
  return h("svg", { className: "marker-defs", "aria-hidden": true, width: 0, height: 0 }, h("defs", null, arrow("arch-arrow"), arrow("arch-arrow-step")));
}

/** Fit the whole level when it stays readable; otherwise show its top at a readable size. */
function fitLevel(flow, area) {
  const bounds = flow.getNodesBounds(flow.getNodes());
  const fit = Math.min(area.width / bounds.width, area.height / bounds.height) * 0.92;
  if (fit >= MIN_FIT_ZOOM) {
    flow.fitView({ padding: 0.08, maxZoom: 1.1 });
    return;
  }
  const drawnWidth = bounds.width * MIN_FIT_ZOOM;
  const x = drawnWidth < area.width ? (area.width - drawnWidth) / 2 : 16;
  flow.setViewport({ x: x - bounds.x * MIN_FIT_ZOOM, y: 16 - bounds.y * MIN_FIT_ZOOM, zoom: MIN_FIT_ZOOM });
}

function Flow({ page, path, selectedId, onChoose }) {
  const { nodes: sourceNodes, edges: sourceEdges, noteLinks } = page.mermaid;
  const flow = RF.useReactFlow();
  const initial = useMemo(
    () =>
      sourceNodes.map((node) => ({
        id: node.id,
        type: node.kind === "note" ? "note" : "box",
        position: { x: 0, y: 0 },
        data: { node, direction: "LR" },
        style: { visibility: "hidden" },
      })),
    [sourceNodes],
  );
  const [nodes, setNodes, onNodesChange] = RF.useNodesState(initial);
  const area = RF.useStore(
    (state) => ({ width: state.width, height: state.height }),
    (a, b) => a.width === b.width && a.height === b.height,
  );
  const measured = RF.useNodesInitialized();
  // Laid out once per drawing area and per Reset; a drag only changes positions, never this key.
  const [placement, setPlacement] = useState({ key: null, reset: 0 });
  const areaKey = `${area.width}x${area.height}:${placement.reset}`;
  const areaNow = useRef(area);
  areaNow.current = area;

  useEffect(() => {
    if (!measured || placement.key === areaKey || !area.width) return;
    const ids = sourceNodes.map((n) => n.id);
    const sizes = new Map(flow.getNodes().map((n) => [n.id, n.measured]));
    const links = [...sourceEdges, ...noteLinks];
    const { direction, positions } = layoutFor(ids, links, sizes, area);
    const saved = savedLayout(path);
    const useSaved = ids.every((id) => saved[id]);
    setNodes((current) =>
      current.map((n) => ({ ...n, position: useSaved ? saved[n.id] : positions.get(n.id), data: { ...n.data, direction }, style: {} })),
    );
    setPlacement((p) => ({ ...p, key: areaKey }));
  }, [measured, placement.key, areaKey, area, flow, sourceNodes, sourceEdges, noteLinks, path, setNodes]);

  // The handles moved with the direction: React Flow must re-measure them before edges draw.
  const updateInternals = RF.useUpdateNodeInternals();
  useEffect(() => {
    if (!placement.key) return;
    updateInternals(sourceNodes.map((n) => n.id));
    const frame = requestAnimationFrame(() => fitLevel(flow, areaNow.current));
    return () => cancelAnimationFrame(frame);
  }, [placement.key, flow, sourceNodes, updateInternals]);

  const linked = useMemo(() => {
    const ids = new Set();
    for (const e of sourceEdges) if (e.from === selectedId || e.to === selectedId) ids.add(e.from).add(e.to);
    for (const l of noteLinks) if (l.from === selectedId || l.to === selectedId) ids.add(l.from).add(l.to);
    return ids;
  }, [sourceEdges, noteLinks, selectedId]);

  const edges = useMemo(
    () => [
      ...sourceEdges.map((edge, i) => {
        const touches = selectedId !== null && (edge.from === selectedId || edge.to === selectedId);
        const marker = edge.step !== null ? "arch-arrow-step" : "arch-arrow";
        return {
          id: `e${i}`,
          source: edge.from,
          target: edge.to,
          label: edge.label,
          labelBgPadding: [6, 3],
          labelBgBorderRadius: 4,
          className: ["edge", edge.step !== null ? "is-step" : "", touches ? "is-lit" : "", selectedId !== null && !touches ? "is-faded" : ""].join(" "),
          markerEnd: marker,
          markerStart: edge.both ? marker : undefined,
          focusable: false,
          selectable: false,
        };
      }),
      ...noteLinks.map((l, i) => ({
        id: `n${i}`,
        source: l.from,
        target: l.to,
        className: `edge note-link ${selectedId !== null && !linked.has(l.from) && !linked.has(l.to) ? "is-faded" : ""}`,
        focusable: false,
        selectable: false,
      })),
    ],
    [sourceEdges, noteLinks, selectedId, linked],
  );

  // Zoomed far out, a side arrow's label can't be read and only crowds the picture; its box's focus shows it.
  const far = RF.useStore((state) => state.transform[2] < 0.62);

  const reset = () => {
    saveLayout(path, null);
    setPlacement((p) => ({ key: null, reset: p.reset + 1 }));
  };

  return h(
    Selection.Provider,
    { value: { selectedId, linked } },
    h(
      RF.ReactFlow,
      {
        className: far ? "is-far" : "",
        nodes,
        edges,
        nodeTypes,
        onNodesChange,
        onNodeClick: (_, node) => node.type === "box" && onChoose(node.id),
        onNodeDragStop: () => saveLayout(path, Object.fromEntries(flow.getNodes().map((n) => [n.id, n.position]))),
        onPaneClick: () => onChoose(null),
        nodesDraggable: true,
        nodesConnectable: false,
        elementsSelectable: false,
        minZoom: 0.15,
        maxZoom: 2,
        proOptions: { hideAttribution: true },
        "aria-label": `${page.title} diagram`,
      },
      h(RF.Background, { variant: RF.BackgroundVariant.Dots, gap: 20, size: 1 }),
      h(RF.Controls, { showInteractive: false, position: "bottom-right" }),
      h(
        RF.Panel,
        { position: "top-left", className: "diagram-tools" },
        h("button", { type: "button", className: "text-button", onClick: () => fitLevel(flow, areaNow.current) }, "Fit"),
        h("button", { type: "button", className: "text-button", onClick: reset, title: "Put the boxes back where the layout places them" }, "Reset layout"),
      ),
    ),
  );
}

/**
 * Mounts the map of `page` (parsed, at repo `path`) into `host`. `nav.go(hash)` opens another
 * route; `nav.replace(hash)` changes the address without a history entry. `parent` is the box
 * that opens this page, if any: { title, hash }. Returns { select(id), dispose() }.
 */
export function createMap(host, { page, path, parent, nav }) {
  let selected = null;
  const canvas = el("div", { class: "canvas" });
  const diagram = el("div", { class: "diagram", id: "map-diagram" });
  const panel = el("aside", { class: "panel", "aria-label": "Selected box" });
  canvas.append(intro(), diagram);
  host.replaceChildren(canvas, panel);

  const flowHost = el("div", { class: "flow" });
  diagram.append(flowHost, legend());
  const root = globalThis.ReactDOM.createRoot(flowHost);
  const drawn = () => {
    root.render(h(RF.ReactFlowProvider, null, h(Markers), h(Flow, { page, path, selectedId: selected, onChoose: choose })));
  };

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
        "numbered arrows are the main path, in order; the rest are side trips, and a dotted note explains the box it touches. Click a box for detail; a box marked ▸ is a group and opens its own page. Drag a box to move it (the layout is remembered on this computer), drag the background to pan, scroll to zoom.",
      ),
    );
  }


  function legend() {
    const kinds = NODE_KINDS.filter((kind) => page.mermaid?.nodes.some((n) => n.kind === kind));
    return el("details", { class: "legend" }, el("summary", null, "Legend"), el("ul", null, kinds.map((kind) => el("li", null, el("span", { class: `swatch kind-${kind}` }), kind))));
  }

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

  // ---- The panel ----

  function select(id) {
    selected = id;
    drawn();
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
        page.mermaid.nodes.filter((n) => n.kind !== "note").map((n) => {
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

  drawn();
  select(null);

  return {
    select(id) {
      if (id !== selected) select(id);
    },
    dispose() {
      root.unmount();
    },
  };
}
