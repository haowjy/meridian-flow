/*
 * Renders Markdown pages from the repo, every ```mermaid block drawn as a diagram: inline
 * (`showPage`, for the map's side panel) and in a wide overlay (`?doc=<path>[#heading]`, so a
 * link to it can be shared and back closes it). A page is fetched at its repo path, so there is
 * no copy of it.
 *
 * A relative link to a .md under a .context/ directory opens in the overlay, one to a map page
 * or a journey opens the viewer there, and any other relative link goes to the file on GitHub.
 */
import { MAP_DIR, resolveHref, slug, sourceUrl } from "./pages.js";
import { el, fetchRepoFile, onThemeChange } from "./shell.js";

// Pinned like the other scripts: marked in the HTML, Mermaid here because it is 3.5 MB and
// loads when the first diagram is drawn.
const MERMAID = {
  src: "https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js",
  integrity: "sha384-T/0lMUdJpd2S1ZHtRiofG3htU3xPCrFVeAQ1UUE2TJwlEJSV5NUwn30kP28n238E",
};

let mermaidLoad = null;
function loadMermaid() {
  mermaidLoad ??= new Promise((resolve, reject) => {
    if (globalThis.mermaid) return resolve(globalThis.mermaid);
    const script = el("script", { src: MERMAID.src, integrity: MERMAID.integrity, crossorigin: "anonymous" });
    script.onload = () => resolve(globalThis.mermaid);
    script.onerror = () => {
      mermaidLoad = null;
      reject(new Error("Mermaid didn't arrive from cdn.jsdelivr.net."));
    };
    document.head.append(script);
  });
  return mermaidLoad;
}

/** A CSS colour as "rgb(r, g, b)", which Mermaid's colour maths parses (it can't read oklch). */
function toRgb(css) {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Mermaid's theme, drawn from the page's tokens so a diagram matches the page in either theme.
 * `look` sets the label sizes and spacing: Mermaid lays the diagram out from them, so CSS can't.
 */
function mermaidConfig(look = {}) {
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
      ...(look.fontSize && { fontSize: `${look.fontSize}px` }),
    },
    ...(look.edgeFontSize && { themeCSS: `.edgeLabel, .edgeLabel p, .edgeLabel span { font-size: ${look.edgeFontSize}px; }` }),
    // Natural size: the map pans and zooms it, and the Markdown panels scroll it.
    state: { useMaxWidth: false },
    flowchart: { useMaxWidth: false, htmlLabels: true, ...look.flowchart },
  };
}

let drawn = 0;

/** Draws Mermaid `source` to an SVG string; throws Mermaid's error for a diagram that can't draw. */
export async function drawDiagram(source, look) {
  const mermaid = await loadMermaid();
  mermaid.initialize(mermaidConfig(look));
  const id = `diagram-${drawn++}`;
  try {
    return (await mermaid.render(id, source)).svg;
  } finally {
    // Mermaid leaves its error graphic and scratch node in the body.
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(id)?.remove();
  }
}

globalThis.marked.use({
  renderer: {
    heading({ tokens, depth }) {
      const html = this.parser.parseInline(tokens);
      return `<h${depth} id="${slug(html)}">${html}</h${depth}>\n`;
    },
  },
});

/**
 * A diagram wider than its holder starts scaled to fit, which shows its shape; the button
 * toggles its natural size, where the text reads and the holder scrolls.
 */
function sizeToFit(holder) {
  const svg = holder.querySelector("svg");
  const natural = svg.viewBox.baseVal.width;
  if (!natural || natural <= holder.clientWidth) return;
  const button = el("button", { type: "button", class: "text-button md-diagram-size" });
  let full = false;
  const set = () => {
    svg.style.width = full ? `${natural}px` : "100%";
    svg.style.maxWidth = full ? "none" : `${natural}px`;
    svg.style.height = "auto";
    button.textContent = full ? "Fit width" : "Full size";
  };
  button.onclick = () => {
    full = !full;
    set();
  };
  holder.prepend(button);
  set();
}

const isContextPage = (path) => path.endsWith(".md") && path.split("/").includes(".context");

/** Where a link in the page at `path` goes: { href, doc?, external } or null to leave it. */
export function route(path, href) {
  const { path: target, fragment, url } = resolveHref(path, href);
  if (url) return { href: url, external: true };
  if (target === null) return null;
  const inMap = target.startsWith(`${MAP_DIR}/`) ? target.slice(MAP_DIR.length + 1) : null;
  if (inMap && /^[\w-]+\.md$/.test(inMap) && inMap !== "README.md") {
    return { href: `index.html#${inMap.slice(0, -3)}${fragment ? `/${fragment}` : ""}` };
  }
  if (inMap?.startsWith("journeys/") && inMap !== "journeys/index.md") {
    return { href: `journeys.html#${inMap.slice(9, -3)}` };
  }
  if (inMap === "journeys/index.md") return { href: "journeys.html" };
  if (isContextPage(target)) {
    const doc = fragment ? `${target}#${fragment}` : target;
    const next = new URL(location.href);
    next.hash = "";
    next.searchParams.set("doc", doc);
    return { href: next.href, doc };
  }
  return { href: sourceUrl(target), external: true };
}

/** Points the links under `root` (from the page at `path`) where `route` says. */
export function fixLinks(root, path) {
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (href.startsWith("#")) continue;
    const to = route(path, href);
    if (!to) continue;
    a.href = to.href;
    if (to.doc) a.dataset.doc = to.doc;
    if (to.external) {
      a.target = "_blank";
      a.rel = "noreferrer";
    }
  }
}

/** Fills `root` with inline Markdown from the page at `path`. */
export function paintInline(root, markdown, path) {
  root.innerHTML = globalThis.marked.parseInline(markdown);
  fixLinks(root, path);
}

/** Fills `root` with Markdown, links resolved against the page at `path`, diagrams drawn. */
export async function paintMarkdown(root, markdown, path) {
  root.innerHTML = globalThis.marked.parse(markdown);
  fixLinks(root, path);
  for (const code of [...root.querySelectorAll("pre > code.language-mermaid")]) {
    const holder = el("div", { class: "md-diagram" });
    code.parentElement.replaceWith(holder);
    try {
      holder.innerHTML = await drawDiagram(code.textContent);
      sizeToFit(holder);
    } catch (error) {
      holder.className = "md-diagram is-error";
      holder.textContent = `This diagram didn't draw: ${error.message ?? error}`;
    }
  }
}

/** Loads the page at `path` into `root`, redrawn when the theme changes. */
export async function showPage(root, path) {
  const paint = async () => {
    try {
      await paintMarkdown(root, await fetchRepoFile(path), path);
    } catch (error) {
      root.replaceChildren(
        el("p", { class: "doc-note" }, `Couldn't load this page (${error.message ?? error}). Read it on GitHub: `, el("a", { href: sourceUrl(path), target: "_blank", rel: "noreferrer" }, path)),
      );
    }
  };
  await paint();
  onThemeChange(() => root.isConnected && paint());
}

// ---- The overlay ----

/** Opens `doc` ("<path>" or "<path>#<heading>") in the overlay, or closes it with null. */
export function openDoc(doc) {
  const url = new URL(location.href);
  if (doc) url.searchParams.set("doc", doc);
  else url.searchParams.delete("doc");
  history.pushState(null, "", url);
  syncOverlay();
}

let host = null;
let overlay = null;
let overlayDoc = null;

/** Mounts the overlay in `workspace`; call once. Links with `data-doc` anywhere on the page open it. */
export function initDocView(workspace) {
  host = workspace;
  addEventListener("popstate", syncOverlay);
  addEventListener("keydown", (event) => event.key === "Escape" && overlay && openDoc(null));
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[data-doc]");
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
    event.preventDefault();
    openDoc(link.dataset.doc);
    overlay?.querySelector(".doc-scroll")?.scrollTo(0, 0);
  });
  syncOverlay();
}

function syncOverlay() {
  const doc = new URLSearchParams(location.search).get("doc");
  if (doc === overlayDoc) return;
  overlayDoc = doc;
  overlay?.remove();
  overlay = null;
  if (!doc) return;
  const [path, fragment] = doc.split("#");
  const body = el("article", { class: "md" });
  const title = path.replace(/\/?\.context\/.*$/, "") || "Repository";
  overlay = el(
    "aside",
    { class: "doc-view", "aria-label": title },
    el(
      "div",
      { class: "doc-head" },
      el("div", { class: "doc-title" }, el("strong", null, title), el("a", { class: "path", href: sourceUrl(path), target: "_blank", rel: "noreferrer" }, path)),
      el("button", { type: "button", class: "icon-button", "aria-label": "Close page", title: "Close page", onclick: () => openDoc(null) }, "×"),
    ),
    el("div", { class: "doc-scroll" }, body),
  );
  host.append(overlay);
  showPage(body, path).then(() => {
    if (overlayDoc !== doc) return;
    const target = fragment && document.getElementById(fragment);
    if (target) target.scrollIntoView();
  });
}
