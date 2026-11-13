/*
 * The panel beside the diagram. With a box selected: what it does, the way in, then what a
 * reader acts on (broken rules, doc drift, state machines, rules that break silently), then the
 * source paths and governing docs. With nothing selected: the level's summary, its rules and
 * the arrows it uses.
 */
(() => {
  const ArchMap = globalThis.ArchMap ?? {};
  globalThis.ArchMap = ArchMap;
  const h = globalThis.React.createElement;

  function Section({ title, tone, items, render = (item) => item }) {
    if (!items?.length) return null;
    return h(
      "section",
      { className: `panel-section${tone ? ` tone-${tone}` : ""}` },
      h("h3", null, title),
      h("ul", null, ...items.map((item, i) => h("li", { key: i }, render(item)))),
    );
  }

  /** A repo path or URL as a link to it, shown as the path. */
  function SourceLink({ data, path }) {
    const { model } = ArchMap;
    const text = model.isUrl(path) ? path.replace(/^https:\/\/github\.com\//, "") : path;
    return h(
      "a",
      { className: "path", href: model.sourceUrl(data, path), target: "_blank", rel: "noreferrer" },
      text,
    );
  }

  /** Inline `code` in the data's sentences, rendered as code. */
  function prose(text) {
    return text
      .split(/(`[^`]+`)/)
      .map((part, i) =>
        part.startsWith("`") && part.endsWith("`")
          ? h("code", { key: i }, part.slice(1, -1))
          : part,
      );
  }

  /** A state-machines page, opened in the doc panel; named by the directory that owns it. */
  function MachineLink({ path, onDoc }) {
    const owner = path.replace(/\/?\.context\/.*$/, "");
    return h(
      "a",
      {
        className: "path",
        href: `?doc=${encodeURIComponent(path)}`,
        onClick: (event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
          event.preventDefault();
          onDoc(path);
        },
      },
      owner,
    );
  }

  function NodeDetails({ data, node, onOpen, onGo, onClose, onDoc }) {
    const { icons, model, ShotView } = ArchMap;
    const link = (path) => h(SourceLink, { data, path });
    return h(
      "div",
      { className: "panel-body" },
      h(
        "div",
        { className: "panel-head" },
        h("div", { className: "panel-kind" }, node.tag ?? model.KIND_LABELS[node.kind]),
        h(
          "button",
          {
            type: "button",
            className: "icon-button",
            onClick: onClose,
            "aria-label": "Close details",
            title: "Close details",
          },
          "×",
        ),
      ),
      h("h2", null, node.label),
      h("p", { className: "panel-about" }, prose(node.about)),
      node.child
        ? h(
            "button",
            { type: "button", className: "primary-button", onClick: () => onOpen(node.child) },
            icons.layers(),
            h("span", null, `Open ${node.label}`),
          )
        : null,
      node.shot ? h(ShotView, { data, shotRef: node.shot, onGo }) : null,
      h(Section, {
        title: "Breaks the dependency rule",
        tone: "breaks",
        items: node.breaks,
        render: prose,
      }),
      h(Section, {
        title: "Docs disagree with the code",
        tone: "drift",
        items: node.drift,
        render: prose,
      }),
      h(Section, {
        title: "State machines",
        items: node.machines,
        render: (path) => h(MachineLink, { path, onDoc }),
      }),
      h(Section, { title: "Rules that break silently", items: node.rules, render: prose }),
      h(Section, { title: "Source", items: node.paths, render: link }),
      h(Section, { title: "Governed by", items: node.docs, render: link }),
    );
  }

  function Legend({ level }) {
    const { EDGE_KINDS } = ArchMap.model;
    const used = [...new Set(level.edges.map((edge) => edge.kind))];
    if (!used.length) return null;
    return h(
      "section",
      { className: "panel-section" },
      h("h3", null, "Arrows"),
      h(
        "ul",
        { className: "legend" },
        ...used.map((kind) =>
          h(
            "li",
            { key: kind },
            h(
              "svg",
              { width: 36, height: 10, "aria-hidden": true },
              h("line", { x1: 2, y1: 5, x2: 34, y2: 5, className: `legend-line edge-${kind}` }),
            ),
            EDGE_KINDS[kind],
          ),
        ),
        level.edges.some((edge) => edge.breaks)
          ? h(
              "li",
              { key: "breaks" },
              h(
                "svg",
                { width: 36, height: 10, "aria-hidden": true },
                h("line", { x1: 2, y1: 5, x2: 34, y2: 5, className: "legend-line is-break" }),
              ),
              "Breaks the dependency rule",
            )
          : null,
      ),
    );
  }

  function LevelOverview({ data, level, arrow }) {
    const link = (path) => h(SourceLink, { data, path });
    const label = (id) => level.nodes.find((n) => n.id === id)?.label ?? id;
    const edge = arrow && level.edges.find((e) => e.from === arrow.from && e.to === arrow.to);
    return h(
      "div",
      { className: "panel-body" },
      h("h2", null, level.title),
      h("p", { className: "panel-about" }, prose(level.summary)),
      edge
        ? h(Section, {
            title: "Highlighted arrow",
            items: [
              `${label(edge.from)} → ${label(edge.to)}: ${ArchMap.model.EDGE_KINDS[edge.kind]}${edge.label ? `, ${edge.label}` : ""}`,
            ],
          })
        : null,
      h(Section, { title: "Rules here", items: level.rules, render: prose }),
      h(Section, { title: "Governed by", items: level.docs, render: link }),
      h(Legend, { level }),
      h("p", { className: "panel-hint" }, "Pick a box for its sources, docs and rules."),
    );
  }

  function SidePanel({ data, level, node, arrow, onOpen, onGo, onClose, onDoc }) {
    return h(
      "aside",
      {
        className: "panel",
        "aria-label": node ? `${node.label} details` : `${level.title} overview`,
      },
      node
        ? h(NodeDetails, { data, node, onOpen, onGo, onClose, onDoc })
        : h(LevelOverview, { data, level, arrow }),
    );
  }

  ArchMap.SourceLink = SourceLink;
  ArchMap.MachineLink = MachineLink;
  ArchMap.SidePanel = SidePanel;
})();
