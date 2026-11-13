/*
 * Mounts the page, or says why it can't: the diagram libraries didn't load (they come from
 * cdn.jsdelivr.net), or the map's data is malformed (check.mjs names the same problems).
 */
(() => {
  const root = document.getElementById("root");
  const fail = (title, lines) => {
    root.replaceChildren();
    const box = document.createElement("div");
    box.className = "page-state";
    const heading = document.createElement("h1");
    heading.textContent = title;
    box.append(heading);
    for (const line of lines) {
      const p = document.createElement("p");
      p.textContent = line;
      box.append(p);
    }
    root.append(box);
  };

  const missing = ["React", "ReactDOM", "ReactFlow", "dagre", "marked"].filter((name) => !globalThis[name]);
  if (missing.length) {
    fail("The diagram couldn't load", [
      `These libraries didn't arrive from cdn.jsdelivr.net: ${missing.join(", ")}.`,
      "Check the connection and reload the page.",
    ]);
    return;
  }
  const data = globalThis.ARCHITECTURE;
  const errors = globalThis.ArchMap.model.validate(data);
  if (errors.length) {
    fail("The map's data has problems", [
      ...errors,
      "Fix architecture.js; pnpm check:architecture lists the same.",
    ]);
    return;
  }
  globalThis.ReactDOM.createRoot(root).render(
    globalThis.React.createElement(globalThis.ArchMap.App, { data }),
  );
})();
