/*
 * The page's top line: where you are (a breadcrumb from the root to this level, each step a
 * plain hash link so the back button goes up), the state machines index and the
 * theme switch.
 */
(() => {
  const ArchMap = globalThis.ArchMap ?? {};
  globalThis.ArchMap = ArchMap;
  const React = globalThis.React;
  const h = React.createElement;
  
  function Breadcrumb({ steps }) {
    return h(
      "nav",
      { className: "breadcrumb", "aria-label": "Where you are" },
      h(
        "ol",
        null,
        ...steps.map((level, i) =>
          h(
            "li",
            { key: level.id },
            i === steps.length - 1
              ? h("span", { "aria-current": "page" }, level.title)
              : h("a", { href: `#${level.id}` }, level.title),
          ),
        ),
      ),
    );
  }

  function ThemeSwitch() {
    const { icons, theme } = ArchMap;
    const shown = theme.use();
    const next = shown === "dark" ? "light" : "dark";
    return h(
      "button",
      {
        type: "button",
        className: "icon-button",
        onClick: () => theme.pin(next),
        "aria-label": `Switch to the ${next} theme`,
        title: `Switch to the ${next} theme`,
      },
      next === "dark" ? icons.moon() : icons.sun(),
    );
  }

  /**
   * The map's roots, the breadcrumb, the state machines index (`onMachines` opens it) and the
   * theme switch.
   */
  function Header({ data, steps, onMachines }) {
    const rootId = steps[0]?.id;
    return h(
      "header",
      { className: "topbar" },
      h(
        "nav",
        { className: "roots", "aria-label": "Maps" },
        ...data.roots.map((root) =>
          h(
            "a",
            {
              key: root.id,
              href: `#${root.id}`,
              "aria-current": root.id === rootId ? "true" : undefined,
            },
            root.label,
          ),
        ),
      ),
      h(Breadcrumb, { steps }),
      h(
        "button",
        { type: "button", className: "text-button", onClick: onMachines },
        ArchMap.icons.machine(),
        h("span", null, "State machines"),
      ),
      h(ThemeSwitch),
    );
  }

  ArchMap.Header = Header;
})();
