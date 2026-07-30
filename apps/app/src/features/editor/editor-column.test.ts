/**
 * The column's gutter fits the chrome that is drawn in it.
 *
 * Two numbers decide whether the block handle is a control or a sliver, and
 * they live in different modules for good reasons: the reach is geometry
 * (`surfaces/blocks/block-geometry.ts`) and the gutter is a Tailwind class
 * string, which has to be literal or the compiler never emits the utility. So
 * neither side can read the other, and the seam between them is here.
 *
 * It is worth a test rather than a comment because the failure is silent. The
 * pane clips what leaves it, so a gutter that stops clearing the reach costs
 * no layout error, no warning, and no failing assertion anywhere else — just a
 * grip the writer can see half of.
 */
import { describe, expect, it } from "vitest";

import { editorColumnCanvas, editorColumnChrome, editorProseClass } from "./editor-column";
import { MARGIN_GUTTER_MIN } from "./surfaces/blocks/block-geometry";

/** Tailwind's spacing unit: `px-6` is 6 × 0.25rem, 24px at a 16px root. */
const SPACING_PX = 4;

type Breakpoint = "base" | "sm" | "md";
const BREAKPOINTS: Breakpoint[] = ["base", "sm", "md"];

/**
 * The horizontal padding a recipe resolves to at each breakpoint, cascading
 * the way the stylesheet does: a width with no utility of its own keeps the
 * one below it.
 */
function insets(recipe: string): Record<Breakpoint, number> {
  const declared: Partial<Record<Breakpoint, number>> = {};
  for (const token of recipe.split(/\s+/)) {
    const match = /^(?:(sm|md):)?px-(\d+)$/.exec(token);
    if (match) declared[(match[1] ?? "base") as Breakpoint] = Number(match[2]) * SPACING_PX;
  }
  if (declared.base === undefined) throw new Error(`no unprefixed px- utility in "${recipe}"`);
  return {
    base: declared.base,
    sm: declared.sm ?? declared.base,
    md: declared.md ?? declared.sm ?? declared.base,
  };
}

const canvas = insets(editorColumnCanvas);
const prose = insets(editorProseClass("docked"));
const chrome = insets(editorColumnChrome);

describe("the manuscript's left gutter", () => {
  it.each(BREAKPOINTS)("holds the whole margin handle at %s", (breakpoint) => {
    expect(canvas[breakpoint] + prose[breakpoint]).toBeGreaterThanOrEqual(MARGIN_GUTTER_MIN);
  });

  it.each(BREAKPOINTS)("starts the toolbar exactly where the prose starts at %s", (breakpoint) => {
    expect(chrome[breakpoint]).toBe(canvas[breakpoint] + prose[breakpoint]);
  });

  it("puts the column in the same place with the toolbar and without it", () => {
    // The toolbar changes the prose's top reserve and nothing sideways, or
    // switching tabs to a host that mounts no toolbar would shift the text.
    expect(insets(editorProseClass("none"))).toEqual(prose);
  });
});
