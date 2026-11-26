import { resolveUiTheme } from "@/lib/ui-theme";

const DIAGRAM_TOKENS: Readonly<Record<string, string>> = {
  background: "--color-background",
  primaryColor: "--color-card",
  mainBkg: "--color-card",
  primaryBorderColor: "--color-muted-foreground",
  nodeBorder: "--color-muted-foreground",
  primaryTextColor: "--color-foreground",
  textColor: "--color-foreground",
  titleColor: "--color-foreground",
  lineColor: "--color-muted-foreground",

  secondaryColor: "--color-ink-fill",
  secondaryBorderColor: "--color-border",
  secondaryTextColor: "--color-foreground",
  tertiaryColor: "--color-background",
  tertiaryBorderColor: "--color-border-subtle",
  tertiaryTextColor: "--color-foreground",
  clusterBkg: "--color-ink-fill",
  clusterBorder: "--color-border",

  edgeLabelBackground: "--color-background",
  labelBackground: "--color-background",
  labelColor: "--color-foreground",

  actorBkg: "--color-card",
  actorBorder: "--color-muted-foreground",
  actorTextColor: "--color-foreground",
  actorLineColor: "--color-border",
  signalColor: "--color-muted-foreground",
  signalTextColor: "--color-foreground",
  labelBoxBkgColor: "--color-card",
  labelBoxBorderColor: "--color-muted-foreground",
  labelTextColor: "--color-foreground",
  loopTextColor: "--color-foreground",
  activationBkgColor: "--color-ink-fill",
  activationBorderColor: "--color-border",
  noteBkgColor: "--color-warning-tint",
  noteTextColor: "--color-warning-ink",
  noteBorderColor: "--color-border",

  errorBkgColor: "--color-destructive-tint",
  errorTextColor: "--color-destructive",
};

export type MermaidTheme = {
  variables: Record<string, string>;
  fontFamily: string;
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
function createColorResolver(ground: string): (css: string) => string | null {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  return (css) => {
    if (!context || !css) return null;
    context.fillStyle = ground;
    context.fillRect(0, 0, 1, 1);
    context.fillStyle = "#000";
    context.fillStyle = css;
    // An unparseable value leaves `fillStyle` at the previous one, so a token
    // that has gone missing reads as black instead of silently as paper.
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return `rgb(${red}, ${green}, ${blue})`;
  };
}

export function readMermaidTheme(): MermaidTheme | null {
  if (typeof document === "undefined") return null;

  const computed = getComputedStyle(document.documentElement);
  const resolve = createColorResolver(computed.getPropertyValue("--color-background").trim());

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
