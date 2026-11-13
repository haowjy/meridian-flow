/*
 * One level as a React Flow diagram. Boxes render hidden first so React Flow can measure
 * them; once every box has a size, dagre places them and the view fits. The parent remounts
 * this per level (its `key`), so a layout never carries over.
 */
(() => {
  const ArchMap = globalThis.ArchMap ?? {};
  globalThis.ArchMap = ArchMap;
  const React = globalThis.React;
  const h = React.createElement;
  const { useEffect, useMemo, useRef, useState } = React;
  const RF = globalThis.ReactFlow;

  const nodeTypes = { arch: (props) => h(ArchMap.ArchNode, props) };

  function toNodes(level, onOpen) {
    return level.nodes.map((node) => ({
      id: node.id,
      type: "arch",
      position: { x: 0, y: 0 },
      data: { node, direction: "LR", onOpen },
      style: { visibility: "hidden" },
    }));
  }

  /** `selectedId`'s arrows are highlighted, or just `arrow` (a link's): the rest fade. */
  function toEdges(level, selectedId, arrow) {
    const focused = selectedId !== null || arrow !== null;
    return level.edges.map((edge, i) => {
      const touches =
        selectedId !== null
          ? edge.from === selectedId || edge.to === selectedId
          : arrow !== null && edge.from === arrow.from && edge.to === arrow.to;
      const faded = focused && !touches;
      const marker = touches ? "arch-arrow-hi" : edge.breaks ? "arch-arrow-break" : "arch-arrow";
      return {
        id: `e${i}`,
        source: edge.from,
        target: edge.to,
        label: edge.label || undefined,
        className: [
          "edge",
          `edge-${edge.kind}`,
          edge.breaks ? "is-break" : "",
          touches ? "is-hi" : "",
          faded ? "is-faded" : "",
        ].join(" "),
        markerEnd: marker,
        markerStart: edge.both ? marker : undefined,
        focusable: false,
        selectable: false,
      };
    });
  }

  /** The arrowheads every edge refers to by id, coloured from tokens by CSS. */
  function Markers() {
    const arrow = (id) =>
      h(
        "marker",
        {
          key: id,
          id,
          viewBox: "0 0 10 10",
          refX: 9,
          refY: 5,
          markerWidth: 7,
          markerHeight: 7,
          orient: "auto-start-reverse",
          markerUnits: "strokeWidth",
        },
        h("path", { d: "M0,0 L10,5 L0,10 Z", className: id }),
      );
    return h(
      "svg",
      { className: "marker-defs", "aria-hidden": true, width: 0, height: 0 },
      h("defs", null, arrow("arch-arrow"), arrow("arch-arrow-hi"), arrow("arch-arrow-break")),
    );
  }

  /** Below this scale box text is unreadable, so a big level opens at its top, readable, to pan. */
  const MIN_FIT_ZOOM = 0.55;

  /** Fit the whole level when it stays readable; otherwise show its top at a readable size. */
  function fitLevel(flow, area) {
    const bounds = flow.getNodesBounds(flow.getNodes());
    const fit = Math.min(area.width / bounds.width, area.height / bounds.height) * 0.92;
    if (fit >= MIN_FIT_ZOOM) {
      flow.fitView({ padding: 0.08, maxZoom: 1 });
      return;
    }
    const zoom = MIN_FIT_ZOOM;
    const drawnWidth = bounds.width * zoom;
    const x = drawnWidth < area.width ? (area.width - drawnWidth) / 2 : 16;
    flow.setViewport({ x: x - bounds.x * zoom, y: 16 - bounds.y * zoom, zoom });
  }

  function Flow({ level, selectedId, arrow, onSelect, onOpen }) {
    const flow = RF.useReactFlow();
    const [nodes, setNodes, onNodesChange] = RF.useNodesState(
      useMemo(() => toNodes(level, onOpen), [level, onOpen]),
    );
    const area = RF.useStore(
      (state) => ({ width: state.width, height: state.height }),
      (a, b) => a.width === b.width && a.height === b.height,
    );
    const edges = useMemo(() => toEdges(level, selectedId, arrow), [level, selectedId, arrow]);
    const measured = RF.useNodesInitialized();
    // The drawing area the boxes were last placed for. Only a real resize changes the area (the
    // phone panel has a fixed height), so placing again then never undoes a reader's pan.
    const areaKey = `${area.width}x${area.height}`;
    const [placedFor, setPlacedFor] = useState(null);
    const areaNow = useRef(area);
    areaNow.current = area;

    useEffect(() => {
      if (!measured || placedFor === areaKey || !area.width) return;
      const sizes = new Map(flow.getNodes().map((n) => [n.id, n.measured]));
      const { direction, positions } = ArchMap.layout.best(level, sizes, area);
      setNodes((current) =>
        current.map((n) => ({
          ...n,
          position: positions.get(n.id),
          data: { ...n.data, direction },
          style: {},
        })),
      );
      setPlacedFor(areaKey);
    }, [measured, placedFor, areaKey, area, flow, level, setNodes]);

    // The handles moved with the direction: React Flow must re-measure them before edges draw.
    const updateInternals = RF.useUpdateNodeInternals();
    useEffect(() => {
      if (!placedFor) return;
      updateInternals(level.nodes.map((n) => n.id));
      const frame = requestAnimationFrame(() => fitLevel(flow, areaNow.current));
      return () => cancelAnimationFrame(frame);
    }, [placedFor, flow, level, updateInternals]);

    // The page's selection drives React Flow's, so the panel and the boxes always agree.
    useEffect(() => {
      setNodes((current) =>
        current.map((n) =>
          n.selected === (n.id === selectedId) ? n : { ...n, selected: n.id === selectedId },
        ),
      );
    }, [selectedId, setNodes]);

    return h(
      RF.ReactFlow,
      {
        nodes,
        edges,
        nodeTypes,
        onNodesChange,
        onNodeClick: (_, node) => onSelect(node.id),
        onNodeDoubleClick: (_, node) => {
          const child = level.nodes.find((n) => n.id === node.id)?.child;
          if (child) onOpen(child);
        },
        onPaneClick: () => onSelect(null),
        nodesDraggable: false,
        nodesConnectable: false,
        elementsSelectable: true,
        selectNodesOnDrag: false,
        minZoom: 0.15,
        maxZoom: 2,
        "aria-label": `${level.title} diagram`,
      },
      h(RF.Background, { variant: RF.BackgroundVariant.Dots, gap: 20, size: 1 }),
      h(RF.Controls, { showInteractive: false, position: "bottom-left" }),
    );
  }

  function Diagram(props) {
    return h(RF.ReactFlowProvider, null, h(Markers), h(Flow, props));
  }

  ArchMap.Diagram = Diagram;
})();
