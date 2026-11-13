/*
 * The page's theme. It follows the system's light or dark setting until the reader pins one;
 * the pin is a per-browser convenience, so storage that throws (a private window, blocked site
 * data) just means the page follows the system again next time. `use` is the theme in force,
 * for what a stylesheet can't reach (the diagrams Mermaid draws).
 */
(() => {
  const ArchMap = globalThis.ArchMap ?? {};
  globalThis.ArchMap = ArchMap;
  const KEY = "meridian-architecture-theme";
  const listeners = new Set();

  /** The theme the page shows now: a pinned one, else the system's. */
  const current = () =>
    document.documentElement.dataset.theme ??
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  function pin(theme) {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Not remembered; the pin still holds for this visit.
    }
    for (const listener of listeners) listener();
  }

  function restore() {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
    } catch {
      // No storage: follow the system.
    }
  }

  /** The theme in force, re-read when it is pinned or the system's setting changes. */
  function use() {
    const [theme, setTheme] = globalThis.React.useState(current);
    globalThis.React.useEffect(() => {
      const update = () => setTheme(current());
      const media = matchMedia("(prefers-color-scheme: dark)");
      listeners.add(update);
      media.addEventListener("change", update);
      return () => {
        listeners.delete(update);
        media.removeEventListener("change", update);
      };
    }, []);
    return theme;
  }

  restore();
  ArchMap.theme = { pin, use };
})();
