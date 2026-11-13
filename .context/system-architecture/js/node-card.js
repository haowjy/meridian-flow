/*
 * One box on the diagram. What it is (tag), its name, one line on what it does, and the
 * markers a reader scans for: the state machines it owns, a broken dependency rule, docs that
 * disagree with the code. A box with a level inside it looks stacked and has an Open button.
 */
(() => {
  const ArchMap = globalThis.ArchMap ?? {};
  globalThis.ArchMap = ArchMap;
  const h = globalThis.React.createElement;
  const { Handle, Position } = globalThis.ReactFlow;

  const sides = {
    LR: { target: Position.Left, source: Position.Right },
    TB: { target: Position.Top, source: Position.Bottom },
  };

  /** The state machines line: a reader scanning for where state is modelled looks for it. */
  const machinesText = (node) =>
    node.machines.length === 1 ? "1 state machine page" : `${node.machines.length} state machine pages`;

  function Marker({ tone, icon, text }) {
    return h("span", { className: `card-marker tone-${tone}` }, icon(), h("span", null, text));
  }

  function ArchNode({ data, selected }) {
    const { node, direction, onOpen } = data;
    const { icons, model } = ArchMap;
    const side = sides[direction];
    const classes = [
      "card",
      `kind-${node.kind}`,
      node.child ? "has-child" : "",
      selected ? "is-selected" : "",
    ].join(" ");
    const markers = [
      node.machines?.length
        ? h(Marker, { key: "m", tone: "machines", icon: icons.machine, text: machinesText(node) })
        : null,
      node.breaks?.length
        ? h(Marker, {
            key: "b",
            tone: "breaks",
            icon: icons.alert,
            text: "Breaks the dependency rule",
          })
        : null,
      node.drift?.length
        ? h(Marker, { key: "d", tone: "drift", icon: icons.docs, text: "Docs disagree with code" })
        : null,
    ].filter(Boolean);
    return h(
      "div",
      { className: classes },
      h(Handle, { type: "target", position: side.target, isConnectable: false }),
      h("div", { className: "card-tag" }, node.tag ?? model.KIND_LABELS[node.kind]),
      h("div", { className: "card-label" }, node.label),
      h("div", { className: "card-sub" }, node.sub),
      markers.length ? h("div", { className: "card-markers" }, ...markers) : null,
      node.shot ? h(ArchMap.Thumb, { shotRef: node.shot }) : null,
      node.child
        ? h(
            "button",
            {
              type: "button",
              className: "card-open nodrag",
              "aria-label": `Open ${node.label}`,
              onClick: (event) => {
                event.stopPropagation();
                onOpen(node.child);
              },
            },
            h("span", null, "Open"),
            icons.chevron(),
          )
        : null,
      h(Handle, { type: "source", position: side.source, isConnectable: false }),
    );
  }

  ArchMap.ArchNode = ArchNode;
})();
