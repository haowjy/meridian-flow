/* The few icons the page draws, as inline SVG in currentColor (Lucide's shapes). */
(() => {
  const ArchMap = globalThis.ArchMap ?? {};
  globalThis.ArchMap = ArchMap;
  const h = globalThis.React.createElement;

  const svg = (children, size = 14) =>
    h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
        focusable: false,
      },
      ...children,
    );

  ArchMap.icons = {
    lock: () =>
      svg([
        h("rect", { key: "b", x: 4, y: 11, width: 16, height: 10, rx: 2 }),
        h("path", { key: "s", d: "M8 11V7a4 4 0 0 1 8 0v4" }),
      ]),
    alert: () =>
      svg([
        h("path", {
          key: "t",
          d: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
        }),
        h("path", { key: "l", d: "M12 9v4M12 17h.01" }),
      ]),
    docs: () =>
      svg([
        h("path", { key: "p", d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }),
        h("path", { key: "f", d: "M14 2v6h6M9 13h6M9 17h6" }),
      ]),
    machine: () =>
      svg([
        h("circle", { key: "a", cx: 5, cy: 6, r: 2.5 }),
        h("circle", { key: "b", cx: 19, cy: 6, r: 2.5 }),
        h("circle", { key: "c", cx: 12, cy: 19, r: 2.5 }),
        h("path", { key: "p", d: "M7.5 6h9M6.5 8l4.5 9M17.5 8 13 17" }),
      ]),
    chevron: () => svg([h("path", { key: "c", d: "m9 18 6-6-6-6" })]),
    layers: () =>
      svg([
        h("path", { key: "a", d: "m12 2 10 5-10 5L2 7Z" }),
        h("path", { key: "b", d: "m2 17 10 5 10-5M2 12l10 5 10-5" }),
      ]),
    sun: () =>
      svg(
        [
          h("circle", { key: "c", cx: 12, cy: 12, r: 4 }),
          h("path", {
            key: "r",
            d: "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
          }),
        ],
        16,
      ),
    moon: () => svg([h("path", { key: "m", d: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" })], 16),
  };
})();
