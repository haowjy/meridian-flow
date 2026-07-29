/**
 * Chrome that is not legible does not take clicks.
 *
 * Every approach surface fades rather than unmounting, and a fading element is
 * still in the page taking hit tests. The failure this holds shut is the
 * destructive one: a writer aims a click at the prose, an add tab or a chip
 * they never saw takes it instead, and the document changes — a row appears, a
 * caret lands inside a table. The whole mechanism is two CSS rules per surface,
 * which is why the assertion is over the stylesheet: nothing else can reach it,
 * since jsdom has no cascade and a browser probe cannot be a merge gate.
 *
 * The two rules are asymmetric on purpose. Leaving: `pointer-events` drops on
 * the frame the fade starts, so a dismissed surface is inert while it is still
 * fully painted. Arriving: it is held off for the whole fade (`step-end`), so a
 * surface revealed under a resting pointer cannot take the click already on its
 * way to the words underneath.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Every surface that fades in over the manuscript, and the sheet it lives in. */
const FADING_SURFACES = [
  { selector: ".meridian-object-overlay", sheet: "./object-overlay.css" },
  { selector: ".meridian-table-chrome", sheet: "../surfaces/table/table-chrome.css" },
  { selector: ".meridian-block-handle", sheet: "../surfaces/blocks/block-movement.css" },
] as const;

function declarations(sheet: string, selector: string, state: string): string {
  const source = readFileSync(fileURLToPath(new URL(sheet, import.meta.url)), "utf8");
  const rule = new RegExp(
    `\\${selector}\\[data-state="${state}"\\]\\s*\\{([^}]*)\\}`.replace("\\.", "\\."),
  );
  const found = source.match(rule);
  if (!found) throw new Error(`no ${selector}[data-state="${state}"] rule in ${sheet}`);
  return found[1];
}

describe.each(FADING_SURFACES)("$selector", ({ selector, sheet }) => {
  it("stops taking clicks the moment it is dismissed", () => {
    expect(declarations(sheet, selector, "closed")).toMatch(/pointer-events:\s*none/);
  });

  it("takes clicks only after it has finished fading in", () => {
    const open = declarations(sheet, selector, "open");
    expect(open).toMatch(/pointer-events:\s*auto/);
    // `step-end` on a discrete property flips it at the END of the duration,
    // which is what makes "auto" mean "and by now the writer can see me".
    expect(open).toMatch(/pointer-events\s+\d+ms\s+step-end\s+allow-discrete/);
  });
});
