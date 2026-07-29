/**
 * A diagram drawn in the manuscript's own ink.
 *
 * Mermaid ships a lavender-on-white stock theme with Trebuchet labels. Dropped
 * into a chapter it reads as a screenshot from another application — the one
 * thing on the page that did not come from this product (§5.2: paper ground,
 * ink strokes, Inter labels).
 *
 * So the palette is the design tokens, read from the live document at render
 * time rather than copied into this file. Copies would be raw colors outside
 * `design-tokens`, and they would freeze: the writer's theme switch re-points
 * the same custom properties, and reading them per render is what lets a
 * diagram follow.
 */

import { resolveUiTheme } from "@/lib/ui-theme";

/**
 * Which token paints which part of a diagram.
 *
 * Structure is warm ink on lifted paper, the same ladder the manuscript uses:
 * nodes are cards, strokes are the subtle ink that hairlines use, labels are
 * prose. Jade stays out of it — jade is the interactive voice, and a diagram
 * is something the writer reads, not something they press.
 */
const DIAGRAM_TOKENS: Readonly<Record<string, string>> = {
  // ── shared ground ────────────────────────────────────────────────
  background: "--color-background",
  primaryColor: "--color-card",
  mainBkg: "--color-card",
  primaryBorderColor: "--color-ink-subtle",
  nodeBorder: "--color-ink-subtle",
  primaryTextColor: "--color-prose-foreground",
  textColor: "--color-prose-foreground",
  titleColor: "--color-foreground",
  lineColor: "--color-ink-muted",

  // Alternates: mermaid reaches for these on subgraphs, clusters, and any
  // second surface a diagram type invents.
  secondaryColor: "--color-muted",
  secondaryBorderColor: "--color-border",
  secondaryTextColor: "--color-prose-foreground",
  tertiaryColor: "--color-background",
  tertiaryBorderColor: "--color-border-subtle",
  tertiaryTextColor: "--color-prose-foreground",
  clusterBkg: "--color-muted",
  clusterBorder: "--color-border",

  // Edge labels sit ON the paper, so they carry the page's own ground rather
  // than a white card that would punch a hole in it.
  edgeLabelBackground: "--color-background",
  labelBackground: "--color-background",
  labelColor: "--color-prose-foreground",

  // ── sequence diagrams ────────────────────────────────────────────
  actorBkg: "--color-card",
  actorBorder: "--color-ink-subtle",
  actorTextColor: "--color-prose-foreground",
  actorLineColor: "--color-border",
  signalColor: "--color-ink-muted",
  signalTextColor: "--color-prose-foreground",
  labelBoxBkgColor: "--color-card",
  labelBoxBorderColor: "--color-ink-subtle",
  labelTextColor: "--color-prose-foreground",
  loopTextColor: "--color-prose-foreground",
  activationBkgColor: "--color-muted",
  activationBorderColor: "--color-border",
  // Notes are the one place a diagram raises its voice, so they borrow the
  // warning family the editor already uses for "read this".
  noteBkgColor: "--color-warning-bg",
  noteTextColor: "--color-warning-foreground",
  noteBorderColor: "--color-warning-border",

  errorBkgColor: "--color-destructive-tint",
  errorTextColor: "--color-destructive",
};

export type MermaidTheme = {
  variables: Record<string, string>;
  fontFamily: string;
  /** Changes exactly when the palette does, so a caller can skip re-applying. */
  signature: string;
};

/**
 * Mermaid's color math (khroma) parses CSS color *functions*, not arbitrary
 * modern syntax: handed `oklch(...)` it produces nothing usable, and the
 * derived shades a theme leans on come out wrong or missing.
 *
 * The browser is the only thing that knows what a token means, so it is asked:
 * paint one pixel and read it back. The literal that comes out is a
 * measurement of a token, not a color anybody authored — which is why a `rgb()`
 * string appearing outside `design-tokens` is not the drift the rule forbids.
 */
function createColorResolver(): (css: string) => string | null {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  return (css) => {
    if (!context || !css) return null;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#000";
    context.fillStyle = css;
    // An unparseable value leaves `fillStyle` at the previous one, so a token
    // that has gone missing reads as black instead of silently as paper.
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return `rgb(${red}, ${green}, ${blue})`;
  };
}

/**
 * The palette as the document currently defines it.
 *
 * Returns null where there is no document to read (SSR, a test with no DOM);
 * mermaid then keeps its own defaults, which is the right answer for something
 * nobody is looking at.
 */
export function readMermaidTheme(): MermaidTheme | null {
  if (typeof document === "undefined") return null;

  const computed = getComputedStyle(document.documentElement);
  const resolve = createColorResolver();

  const variables: Record<string, string> = {};
  for (const [key, token] of Object.entries(DIAGRAM_TOKENS)) {
    const color = resolve(computed.getPropertyValue(token).trim());
    if (color) variables[key] = color;
  }

  const fontFamily = computed.getPropertyValue("--font-sans").trim() || "Inter, sans-serif";
  variables.fontFamily = fontFamily;
  variables.fontSize = "14px";

  return {
    variables,
    fontFamily,
    // The theme name is in the signature as well as the resolved colors: a
    // switch that lands before the tokens repaint would otherwise look like no
    // change at all.
    signature: `${resolveUiTheme()}|${JSON.stringify(variables)}`,
  };
}
