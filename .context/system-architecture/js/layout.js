/*
 * Automatic layout with dagre: boxes are placed from their measured sizes, so nothing in the
 * data carries a coordinate. Each level is laid out both left to right and top to bottom, and
 * the one that fits the diagram's area at the larger scale wins, so a wide level stays wide on
 * a desktop and a phone gets the tall one.
 */
(() => {
  const ArchMap = globalThis.ArchMap ?? {};
  globalThis.ArchMap = ArchMap;

  /** Top-left positions for every box and the bounds of the drawing, for one direction. */
  function place(level, sizes, direction) {
    const graph = new globalThis.dagre.graphlib.Graph({ multigraph: true });
    graph.setGraph({
      rankdir: direction,
      nodesep: direction === "LR" ? 28 : 36,
      ranksep: direction === "LR" ? 150 : 80,
      edgesep: 16,
      marginx: 16,
      marginy: 16,
    });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const node of level.nodes) {
      const size = sizes.get(node.id) ?? { width: 220, height: 80 };
      graph.setNode(node.id, { width: size.width, height: size.height });
    }
    // An arrow back along a pair already linked would make dagre break a cycle arbitrarily;
    // the first arrow of a pair decides the ranks.
    const linked = new Set();
    level.edges.forEach((edge, i) => {
      if (linked.has(`${edge.to}>${edge.from}`)) return;
      linked.add(`${edge.from}>${edge.to}`);
      graph.setEdge(edge.from, edge.to, {}, `e${i}`);
    });
    globalThis.dagre.layout(graph);
    const positions = new Map();
    for (const node of level.nodes) {
      const { x, y, width, height } = graph.node(node.id);
      positions.set(node.id, { x: x - width / 2, y: y - height / 2 });
    }
    const { width, height } = graph.graph();
    return { direction, positions, width, height };
  }

  /** The direction whose drawing fits `area` at the larger scale. */
  function best(level, sizes, area) {
    const scale = (layout) => Math.min(area.width / layout.width, area.height / layout.height);
    const [wide, tall] = [place(level, sizes, "LR"), place(level, sizes, "TB")];
    return scale(tall) > scale(wide) ? tall : wide;
  }

  ArchMap.layout = { best };
})();
