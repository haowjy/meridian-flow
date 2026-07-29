/**
 * The mermaid render boundary: source text in, SVG markup out.
 *
 * Its own module because it is the one asynchronous, side-effecting edge of
 * diagram rendering — the mermaid bundle is loaded on first use and never
 * again, and a test that wants a diagram without a real parser fakes exactly
 * this function.
 */

import { readMermaidTheme } from "./mermaid-theme";

let mermaidModule: Promise<typeof import("mermaid")["default"]> | null = null;
/** The palette mermaid was last configured with, so a re-apply is skipped. */
let appliedTheme: string | null = null;

const MERMAID_BASE_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  // Mermaid may fetch authored external images before SVG sanitization (#7645).
  // Documents are author-controlled; resource CSP belongs to future app-wide policy.
} as const;

/**
 * `id` is written into the markup, so every consumer needs its own: two faces
 * of one diagram sharing an id collide over the arrow markers they reference,
 * and the page's diagram loses its arrowheads the moment the dialog opens.
 *
 * The palette is re-read here rather than at import time. `initialize` is
 * mermaid's only configuration door and it is global, so the theme is applied
 * whenever it has changed since the last render — which is how a diagram
 * already on the page follows the writer switching themes.
 */
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
      // `base` is the theme built to be overridden; the named themes ignore
      // most of what `themeVariables` says.
      theme: "base",
      themeVariables: theme.variables,
      fontFamily: theme.fontFamily,
    });
    appliedTheme = theme.signature;
  }

  return (await mermaid.render(id, source)).svg;
}
