import { readMermaidTheme } from "./mermaid-theme";

let mermaidModule: Promise<typeof import("mermaid")["default"]> | null = null;
let appliedTheme: string | null = null;

const MERMAID_BASE_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  // Mermaid 12 defaults to ELK layout and the "neo" look (heavier strokes, drop shadows),
  // which draw existing diagrams differently; dagre and classic keep them as authored.
  layout: "dagre",
  look: "classic",
  suppressErrorRendering: true,
  // Labels as SVG text rather than HTML in a `<foreignObject>`, which mermaid
  // does by default. Two reasons, one boundary each: the rendering boundary's
  // allow-list is SVG (`sanitized-svg.ts`), so HTML labels would be dropped on
  // the way to the page; and the export boundary rasterizes the markup through
  // an `<img>` (`surfaces/objects/object-commands.ts`), which paints no
  // `foreignObject` at all — a downloaded diagram used to lose its labels.
  htmlLabels: false,
  // Mermaid may fetch authored external images before SVG sanitization (#7645).
  // Documents are author-controlled; resource CSP belongs to future app-wide policy.
} as const;

export async function renderMermaid(id: string, source: string): Promise<string> {
  mermaidModule ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize(MERMAID_BASE_CONFIG);
    return mermaid;
  });
  const mermaid = await mermaidModule;

  const theme = readMermaidTheme();
  if (theme && theme.signature !== appliedTheme) {
    mermaid.initialize({
      ...MERMAID_BASE_CONFIG,
      theme: "base",
      themeVariables: theme.variables,
      fontFamily: theme.fontFamily,
    });
    appliedTheme = theme.signature;
  }

  return (await mermaid.render(id, source)).svg;
}
