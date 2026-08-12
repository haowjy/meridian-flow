import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Oklch = readonly [number, number, number];
type LinearRgb = readonly [number, number, number];

const source = readFileSync(
  new URL("../../../../../packages/design-tokens/src/ink-jade.css", import.meta.url),
  "utf8",
);
const themes = readFileSync(
  new URL("../../../../../packages/design-tokens/src/themes.css", import.meta.url),
  "utf8",
);

function token(css: string, name: string): Oklch {
  const match = css.match(new RegExp(`--${name}:\\s*oklch\\(([^ ]+) ([^ ]+) ([^)]+)\\)`));
  if (!match) throw new Error(`Missing concrete token --${name}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function rgb([l, c, h]: Oklch): LinearRgb {
  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const ll = l_ ** 3;
  const mm = m_ ** 3;
  const ss = s_ ** 3;
  return [
    4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss,
    -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss,
    -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss,
  ];
}

function composite(foreground: Oklch, background: Oklch, alpha: number): LinearRgb {
  const front = rgb(foreground);
  const back = rgb(background);
  return [0, 1, 2].map(
    (index) => front[index] * alpha + back[index] * (1 - alpha),
  ) as unknown as LinearRgb;
}

function luminance(color: Oklch | LinearRgb, converted = false) {
  const linear = converted ? (color as LinearRgb) : rgb(color as Oklch);
  return linear.reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(a: Oklch, b: Oklch | LinearRgb, bIsRgb = false) {
  const [lighter, darker] = [luminance(a), luminance(b, bIsRgb)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("dropdown focus indicator", () => {
  it.each([
    ["light", source],
    ["dark", themes],
  ])("clears 3:1 against every committed %s dropdown state", (_theme, css) => {
    const indicator = token(css, "color-dropdown-focus-indicator");
    const popover = token(css, "ink-jade-lift");
    const selected = token(css, "color-sidebar-accent");
    const focused = composite(selected, popover, 0.5);

    expect(contrast(indicator, popover)).toBeGreaterThanOrEqual(3);
    expect(contrast(indicator, focused, true)).toBeGreaterThanOrEqual(3);
    expect(contrast(indicator, selected)).toBeGreaterThanOrEqual(3);
  });
});
