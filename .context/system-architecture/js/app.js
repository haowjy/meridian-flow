/*
 * The page: the hash names the level (`#api`, `#api-run`), so a link opens straight into a
 * subsystem and the back button goes up. `#api/routes` opens it with that box selected and
 * `#api/routes-store` with that arrow highlighted (`model.parseHash`). Selection is page state
 * the hash sets when it changes, and a box picked on one level shows as picked only there.
 */
(() => {
  const ArchMap = globalThis.ArchMap ?? {};
  globalThis.ArchMap = ArchMap;
  const React = globalThis.React;
  const h = React.createElement;
  const { useCallback, useEffect, useState } = React;

  // Ids are plain ASCII, so the hash needs no decoding; a mangled one is just an unknown level.
  const readHash = () => location.hash.slice(1);

  function useHash() {
    const [hash, setHash] = useState(readHash);
    useEffect(() => {
      const update = () => setHash(readHash());
      addEventListener("hashchange", update);
      return () => removeEventListener("hashchange", update);
    }, []);
    return hash;
  }

  function Missing({ data, id }) {
    const root = data.roots[0];
    return h(
      "div",
      { className: "page-state" },
      h("h1", null, `There is no level called “${id}”`),
      h("p", null, "It may have been renamed or merged into another level."),
      h(
        "a",
        { className: "primary-button", href: ArchMap.model.hashOf(root.id) },
        `Go to ${root.label}`,
      ),
    );
  }

  /** What the hash selects: its level, and the box or arrow on it when the level has one. */
  function fromHash(model, data, levels, hash) {
    const target = model.parseHash(hash);
    const levelId = target.level === "" ? data.roots[0].id : target.level;
    const level = levels.get(levelId);
    const box = level?.nodes.some((n) => n.id === target.box) ? target.box : null;
    const arrow = level?.edges.some(
      (e) => e.from === target.arrow?.from && e.to === target.arrow?.to,
    )
      ? target.arrow
      : null;
    return { levelId, id: box, arrow };
  }

  function App({ data }) {
    const { model, Header, Diagram, SidePanel, docs } = ArchMap;
    const [doc, openDoc] = docs.useDocParam();
    const levels = React.useMemo(() => model.indexLevels(data), [data]);
    const hash = useHash();
    const { levelId } = fromHash(model, data, levels, hash);
    const level = levels.get(levelId);
    // Selection belongs to the level it was made on: box ids repeat across levels. A new hash
    // sets it again; a link to the hash already showing does too (`go`).
    const [selection, setSelection] = useState(() => fromHash(model, data, levels, hash));
    useEffect(() => setSelection(fromHash(model, data, levels, hash)), [hash]);
    const selectedId = selection.levelId === levelId ? selection.id : null;
    const arrow = selection.levelId === levelId ? selection.arrow : null;
    const select = useCallback((id) => setSelection({ levelId, id, arrow: null }), [levelId]);
    /** Follows a map reference ("<level>/<box>"): the hash, or, when it is showing, its selection. */
    const go = useCallback(
      (ref) => {
        if (readHash() === ref) setSelection(fromHash(model, data, levels, ref));
        else location.hash = ref;
      },
      [model, data, levels],
    );

    useEffect(() => {
      document.title = level ? `${level.title} · Meridian architecture` : "Meridian architecture";
    }, [level]);

    const open = useCallback((id) => {
      location.hash = model.hashOf(id);
    }, []);

    if (!level) return h(Missing, { data, id: levelId });
    const node = level.nodes.find((n) => n.id === selectedId) ?? null;
    const steps = model.trail(levels, level.id);
    return h(
      "div",
      { className: "app" },
      h(Header, { data, steps, onMachines: () => openDoc(docs.INDEX) }),
      h(
        "main",
        { className: "workspace" },
        h(
          "div",
          { className: "diagram" },
          h(Diagram, {
            key: level.id,
            level,
            selectedId,
            arrow,
            onSelect: select,
            onOpen: open,
          }),
        ),
        h(SidePanel, {
          data,
          level,
          node,
          arrow,
          onOpen: open,
          onGo: go,
          onClose: () => select(null),
          onDoc: openDoc,
        }),
        doc
          ? h(docs.DocView, { data, doc, onOpen: openDoc, onClose: () => openDoc(null) })
          : null,
      ),
    );
  }

  ArchMap.App = App;
})();
