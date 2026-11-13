/*
 * Renders a Markdown page from the repo (a state-machines page, or a .context page it links)
 * in a wide panel over the right of the page, every ```mermaid block drawn as a diagram.
 * The page is fetched at its repo path, so there is no copy of it: it works where something
 * serves the repo (`pnpm dev` does) and says so where nothing does (file://).
 *
 * A relative link to a .md under a .context/ directory opens in the panel; any other relative
 * link goes to the file on GitHub. The open page is the `doc` query parameter, so a link to it
 * can be shared and the back button closes it.
 */
(() => {
  const ArchMap = globalThis.ArchMap ?? {};
  globalThis.ArchMap = ArchMap;
  const React = globalThis.React;
  const h = React.createElement;
  const { useCallback, useEffect, useRef, useState } = React;

  /** Where the repo root is, from the map's directory (`.context/system-architecture/`). */
  const REPO_ROOT = "../../";

  /** Mermaid is 3.5 MB, so it loads when the first page with a diagram opens. Pinned like the rest. */
  const MERMAID = {
    src: "https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js",
    integrity: "sha384-T/0lMUdJpd2S1ZHtRiofG3htU3xPCrFVeAQ1UUE2TJwlEJSV5NUwn30kP28n238E",
  };

  let mermaidLoad = null;
  function loadMermaid() {
    mermaidLoad ??= new Promise((resolve, reject) => {
      if (globalThis.mermaid) return resolve(globalThis.mermaid);
      const script = document.createElement("script");
      script.src = MERMAID.src;
      script.integrity = MERMAID.integrity;
      script.crossOrigin = "anonymous";
      script.onload = () => resolve(globalThis.mermaid);
      script.onerror = () => {
        mermaidLoad = null;
        reject(new Error("Mermaid didn't arrive from cdn.jsdelivr.net."));
      };
      document.head.append(script);
    });
    return mermaidLoad;
  }

  /** "<dir>/<href>" with `.` and `..` folded; null when it climbs out of the repo. */
  function joinPath(fromPath, href) {
    const out = fromPath.split("/").slice(0, -1);
    for (const part of href.split("/")) {
      if (part === "..") {
        if (!out.length) return null;
        out.pop();
      } else if (part !== "." && part !== "") out.push(part);
    }
    return out.join("/");
  }

  /** Where a repo path is served from, relative to the map. */
  const fetchUrl = (path) => new URL(REPO_ROOT + path, location.href);

  const isContextPage = (path) => path.endsWith(".md") && path.split("/").includes(".context");

  /** The `doc` query value ("<path>" or "<path>#<heading>"), kept in step with the address bar. */
  function useDocParam() {
    const read = () => new URLSearchParams(location.search).get("doc");
    const [doc, setDoc] = useState(read);
    useEffect(() => {
      const update = () => setDoc(read());
      addEventListener("popstate", update);
      return () => removeEventListener("popstate", update);
    }, []);
    const open = useCallback((value) => {
      const url = new URL(location.href);
      if (value) url.searchParams.set("doc", value);
      else url.searchParams.delete("doc");
      history.pushState(null, "", url);
      setDoc(value);
    }, []);
    return [doc, open];
  }

  /** A CSS colour as "rgb(r, g, b)", which Mermaid's colour maths parses (it can't read oklch). */
  function toRgb(css) {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  }

  /** Mermaid's theme, drawn from the page's tokens so a diagram matches the page in either theme. */
  function mermaidConfig() {
    const style = getComputedStyle(document.documentElement);
    const color = (token) => toRgb(style.getPropertyValue(`--color-${token}`).trim());
    return {
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      fontFamily: style.getPropertyValue("--font-sans"),
      themeVariables: {
        background: color("card"),
        mainBkg: color("background"),
        primaryColor: color("background"),
        primaryTextColor: color("foreground"),
        primaryBorderColor: color("ink-subtle"),
        secondaryColor: color("muted"),
        tertiaryColor: color("muted"),
        lineColor: color("muted-foreground"),
        textColor: color("foreground"),
        noteBkgColor: color("warning-bg"),
        noteTextColor: color("warning-foreground"),
        noteBorderColor: color("warning-foreground"),
        edgeLabelBackground: color("card"),
        clusterBkg: color("muted"),
        clusterBorder: color("border"),
        titleColor: color("foreground"),
      },
      // Natural size, so a wide diagram scrolls instead of shrinking past reading.
      state: { useMaxWidth: false },
      flowchart: { useMaxWidth: false },
    };
  }

  /** GitHub-style heading ids, so `page.md#heading` links land. */
  const slug = (text) =>
    text
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s/g, "-");

  globalThis.marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        return `<h${depth} id="${slug(html)}">${html}</h${depth}>\n`;
      },
    },
  });

  const parse = (markdown) => globalThis.marked.parse(markdown);

  let diagramCount = 0;

  /**
   * A diagram wider than the panel starts scaled to fit it, which shows its shape; the button
   * toggles its natural size, where the text reads and the holder scrolls.
   */
  function sizeToFit(holder) {
    const svg = holder.querySelector("svg");
    const natural = svg.viewBox.baseVal.width;
    if (!natural || natural <= holder.clientWidth) return;
    const set = (full) => {
      svg.style.width = full ? `${natural}px` : "100%";
      svg.style.maxWidth = full ? "none" : `${natural}px`;
      svg.style.height = "auto";
      button.textContent = full ? "Fit width" : "Full size";
      button.setAttribute("aria-pressed", String(full));
    };
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button md-diagram-size";
    let full = false;
    button.onclick = () => set((full = !full));
    holder.prepend(button);
    set(false);
  }

  /** Fills `root` with the page's HTML, links resolved against `path`, diagrams drawn. */
  async function paint(root, html, path, data) {
    root.innerHTML = html;
    for (const a of root.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        a.target = "_blank";
        a.rel = "noreferrer";
      } else if (!href.startsWith("#")) {
        const [file, fragment] = href.split("#");
        const target = joinPath(path, file);
        if (target === null) continue;
        if (isContextPage(target)) {
          const url = new URL(location.href);
          url.searchParams.set("doc", fragment ? `${target}#${fragment}` : target);
          a.href = url.href;
          a.dataset.doc = fragment ? `${target}#${fragment}` : target;
        } else {
          a.href = ArchMap.model.sourceUrl(data, target);
          a.target = "_blank";
          a.rel = "noreferrer";
        }
      }
    }
    const blocks = [...root.querySelectorAll("pre > code.language-mermaid")];
    if (!blocks.length) return;
    const mermaid = await loadMermaid();
    mermaid.initialize(mermaidConfig());
    for (const code of blocks) {
      const holder = document.createElement("div");
      holder.className = "md-diagram";
      code.parentElement.replaceWith(holder);
      try {
        const { svg } = await mermaid.render(`md-diagram-${diagramCount++}`, code.textContent);
        holder.innerHTML = svg;
        sizeToFit(holder);
      } catch (error) {
        holder.className = "md-diagram is-error";
        holder.textContent = `This diagram didn't draw: ${error.message ?? error}`;
        // Mermaid leaves its error graphic in the body.
        document.getElementById(`dmd-diagram-${diagramCount - 1}`)?.remove();
      }
    }
  }

  /** What `path` is, for a title: the directory that owns the page. */
  const titleOf = (path) => path.replace(/\/?\.context\/.*$/, "") || "Repository";

  function DocView({ data, doc, onOpen, onClose }) {
    const [path, fragment] = doc.split("#");
    const [state, setState] = useState({ status: "loading" });
    const body = useRef(null);
    const theme = ArchMap.theme.use();
    const sourceLink = h(
      "a",
      { className: "path", href: ArchMap.model.sourceUrl(data, path), target: "_blank", rel: "noreferrer" },
      path,
    );

    useEffect(() => {
      let current = true;
      setState({ status: "loading" });
      if (location.protocol === "file:") {
        setState({ status: "file" });
        return;
      }
      fetch(fetchUrl(path))
        .then((response) => {
          if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
          return response.text();
        })
        .then((markdown) => current && setState({ status: "ready", html: parse(markdown) }))
        .catch((error) => current && setState({ status: "error", message: String(error.message ?? error) }));
      return () => {
        current = false;
      };
    }, [path]);

    // Draw again when the page or the theme changes; keep the reader's place across a theme switch.
    useEffect(() => {
      if (state.status !== "ready" || !body.current) return;
      const root = body.current;
      const top = root.parentElement.scrollTop;
      let current = true;
      paint(root, state.html, path, data).then(() => {
        if (!current) return;
        const target = fragment && document.getElementById(fragment);
        if (target) target.scrollIntoView();
        else root.parentElement.scrollTop = top;
      });
      return () => {
        current = false;
      };
    }, [state, theme, path, fragment, data]);

    useEffect(() => {
      const onKey = (event) => event.key === "Escape" && onClose();
      addEventListener("keydown", onKey);
      return () => removeEventListener("keydown", onKey);
    }, [onClose]);

    const follow = (event) => {
      const link = event.target.closest?.("a[data-doc]");
      if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
      event.preventDefault();
      onOpen(link.dataset.doc);
      event.currentTarget.parentElement.scrollTop = 0;
    };

    return h(
      "aside",
      { className: "doc-view", "aria-label": `${titleOf(path)} state machines` },
      h(
        "div",
        { className: "doc-head" },
        h("div", { className: "doc-title" }, h("strong", null, titleOf(path)), sourceLink),
        h(
          "button",
          { type: "button", className: "icon-button", onClick: onClose, "aria-label": "Close page", title: "Close page" },
          "×",
        ),
      ),
      h(
        "div",
        { className: "doc-scroll" },
        state.status === "loading" ? h("p", { className: "panel-hint" }, "Loading…") : null,
        state.status === "file"
          ? h(
              "div",
              { className: "doc-note" },
              h("p", null, "A browser won't read repo files from a page opened from disk (file://)."),
              h("p", null, "Run ", h("code", null, "pnpm dev"), " and open the printed architecture URL, or read the file on GitHub: ", sourceLink),
            )
          : null,
        state.status === "error"
          ? h(
              "div",
              { className: "doc-note" },
              h("p", null, `Couldn't load this page (${state.message}).`),
              h("p", null, "Read it on GitHub: ", sourceLink),
            )
          : null,
        state.status === "ready"
          ? h("article", { className: "md", ref: body, onClick: follow })
          : null,
      ),
    );
  }

  ArchMap.docs = { DocView, useDocParam, INDEX: ".context/state-machines/index.md" };
})();
