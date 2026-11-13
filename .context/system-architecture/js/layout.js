/*
 * Automatic layout with dagre: boxes are placed from their measured sizes, so a page carries no
 * coordinates.
 */

/** On a canvas this wide or wider, top to bottom wins only when it draws this many times larger; a narrower one takes whichever draws larger. */
const TALL_BIAS = 1.3;
const NARROW = 560;

/** Top-left positions for every node and the bounds of the drawing, for one direction. */
function place(nodes, links, sizes, direction) {
  const graph = new globalThis.dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: direction,
    nodesep: direction === "LR" ? 40 : 56,
    ranksep: direction === "LR" ? 170 : 120,
    edgesep: 16,
    marginx: 16,
    marginy: 16,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  // dagre breaks a cycle at the edge its depth-first walk closes it, and the walk follows insertion
  // order: walk the numbered path first, so a cycle is broken at its last step, not its first.
  const steps = links.filter((l) => l.step).sort((a, b) => a.step - b.step);
  const ordered = [...new Set([...steps.flatMap((l) => [l.from, l.to]), ...nodes])].filter((id) => nodes.includes(id));
  for (const id of ordered) {
    const size = sizes.get(id) ?? { width: 200, height: 70 };
    graph.setNode(id, { width: size.width, height: size.height });
  }
  // An arrow back along a pair already linked would make dagre break a cycle arbitrarily; the
  // first arrow of a pair decides the ranks.
  const linked = new Set();
  // The numbered path weighs most, so it stays short and straight.
  const byStep = [...links.map((link, i) => ({ ...link, i }))].sort((a, b) => (a.step ?? Infinity) - (b.step ?? Infinity));
  for (const { from, to, step, i } of byStep) {
    if (linked.has(`${to}>${from}`)) continue;
    linked.add(`${from}>${to}`);
    graph.setEdge(from, to, { weight: step ? 8 : 1 }, `e${i}`);
  }
  globalThis.dagre.layout(graph);
  const positions = new Map();
  for (const id of nodes) {
    const { x, y, width, height } = graph.node(id);
    positions.set(id, { x: x - width / 2, y: y - height / 2 });
  }
  const { width, height } = graph.graph();
  return { direction, positions, width, height };
}

/**
 * The layout of node ids `nodes` joined by `links` ({ from, to, step? }): { direction, positions: Map id → {x, y} }.
 * Left to right, the way the numbered path reads, unless top to bottom fits the area much better
 * (a long level, or a phone). `sizes` maps id → { width, height }.
 */
export function layoutFor(nodes, links, sizes, area) {
  const scale = (layout) => Math.min(area.width / layout.width, area.height / layout.height);
  const [wide, tall] = [place(nodes, links, sizes, "LR"), place(nodes, links, sizes, "TB")];
  return scale(tall) > scale(wide) * (area.width < NARROW ? 1 : TALL_BIAS) ? tall : wide;
}
