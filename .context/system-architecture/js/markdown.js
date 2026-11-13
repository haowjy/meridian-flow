/*
 * Renders Markdown from the repo, every ```mermaid block drawn as a diagram with zoom buttons.
 * A page is fetched at its repo path, so there is no copy of it. Every link in a rendered page
 * becomes a `#` route that app.js handles (`route` below), or a GitHub URL.
 */
import { MAP_DIR, resolveHref, slug, sourceUrl, STATE_MACHINES_INDEX } from "./pages.js";
import { el, fetchRepoFile } from "./shell.js";

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
    themeCSS: `.nodeLabel small { display: block; margin-top: 3px; font-size: 0.68em; opacity: 0.8; }${look.edgeFontSize ? ` .edgeLabel, .edgeLabel p, .edgeLabel span { font-size: ${look.edgeFontSize}px; }` : ""}`,
    // Natural size: the map pans and zooms it, and the Markdown panels scroll it.
    state: { useMaxWidth: false },
    flowchart: { useMaxWidth: false, htmlLabels: true, ...look.flowchart },
    sequence: { useMaxWidth: false },
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

const ZOOM_STEP = 1.25;

/**
 * Zoom buttons for a diagram holder: it starts at natural size, where text reads and the holder
 * scrolls; "Fit" scales it to the holder's width.
 */
function addZoom(holder) {
  const svg = holder.querySelector("svg");
  const natural = svg.viewBox.baseVal.width;
  if (!natural) return;
  let scale = 1;
  const set = (next) => {
    scale = Math.min(Math.max(next, 0.2), 4);
    svg.style.width = `${natural * scale}px`;
    svg.style.maxWidth = "none";
    svg.style.height = "auto";
  };
  const fit = () => set((holder.clientWidth - 26) / natural);
  const button = (label, name, onclick) => el("button", { type: "button", class: "text-button", "aria-label": name, title: name, onclick }, label);
  holder.prepend(
    el(
      "div",
      { class: "md-diagram-tools" },
      button("−", "Zoom out", () => set(scale / ZOOM_STEP)),
      button("100%", "Natural size", () => set(1)),
      button("+", "Zoom in", () => set(scale * ZOOM_STEP)),
      button("Fit", "Fit to width", fit),
    ),
  );
  // A flow fills the width (a little larger than natural at most); other diagrams start at natural size.
  set(svg.getAttribute("aria-roledescription") === "sequence" ? Math.min(Math.max((holder.clientWidth - 26) / natural, 1), 1.6) : 1);
}

const isContextPage = (path) => path.endsWith(".md") && path.split("/").includes(".context");

/** What the doc view can open and the dev server serves: a .context page with no `..`, `.` or empty segment. */
export const isDocPath = (path) => isContextPage(path) && !path.includes("\\") && path.split("/").every((s) => s && s !== "." && s !== "..");

/** The hash that opens a repo page in the doc view. */
export const docHash = (path, fragment) => `#doc/${encodeURIComponent(path)}${fragment ? `/${encodeURIComponent(fragment)}` : ""}`;

/** Where a link in the page at `path` goes: { href, external? }, or null to leave it. Map pages are `#<page>[/<box>]`, `#flows/<id>`, `#journeys/<id>`, `#machines`; other .context pages open in the doc view. */
export function route(path, href) {
  const { path: target, fragment, url } = resolveHref(path, href);
  if (url) return { href: url, external: true };
  if (target === null) return null;
  const inMap = target.startsWith(`${MAP_DIR}/`) ? target.slice(MAP_DIR.length + 1) : null;
  const id = (name) => /^([\w-]+)\.md$/.exec(name)?.[1];
  if (inMap === "flows/index.md") return { href: "#flows" };
  if (inMap === "journeys/index.md") return { href: "#journeys" };
  if (inMap?.startsWith("flows/") && id(inMap.slice(6))) return { href: `#flows/${id(inMap.slice(6))}` };
  if (inMap?.startsWith("journeys/") && id(inMap.slice(9))) return { href: `#journeys/${id(inMap.slice(9))}` };
  if (inMap && id(inMap) && !["README.md", "AGENTS.md"].includes(inMap)) return { href: `#${id(inMap)}${fragment ? `/${fragment}` : ""}` };
  if (target === STATE_MACHINES_INDEX) return { href: "#machines" };
  if (isDocPath(target)) return { href: docHash(target, fragment) };
  return { href: sourceUrl(target), external: true };
}

/** Points the links under `root` (from the page at `path`) where `route` says. */
export function fixLinks(root, path) {
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (href.startsWith("#")) continue;
    const to = route(path, href);
    if (!to) continue;
    a.setAttribute("href", to.href);
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

/**
 * Fills `root` with Markdown, links resolved against the page at `path`, diagrams drawn.
 * `onDiagram(holder, source)` runs after each diagram is drawn, to wire its clicks.
 */
export async function paintMarkdown(root, markdown, path, onDiagram) {
  root.innerHTML = globalThis.marked.parse(markdown);
  fixLinks(root, path);
  for (const code of [...root.querySelectorAll("pre > code.language-mermaid")]) {
    const holder = el("div", { class: "md-diagram" });
    code.parentElement.replaceWith(holder);
    const source = code.textContent;
    try {
      holder.innerHTML = await drawDiagram(source);
      addZoom(holder);
      onDiagram?.(holder, source);
    } catch (error) {
      holder.className = "md-diagram is-error";
      holder.textContent = `This diagram didn't draw: ${error.message ?? error}`;
    }
  }
}

/** The text of a page that didn't load, with a way to read it on GitHub. */
export const loadFailure = (path, error) =>
  el("p", { class: "doc-note" }, `Couldn't load this page (${error.message ?? error}). Read it on GitHub: `, el("a", { href: sourceUrl(path), target: "_blank", rel: "noreferrer" }, path));
