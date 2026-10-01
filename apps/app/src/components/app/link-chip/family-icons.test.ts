/** The generated chip icon rules: one per family, after a generic default. */

import { describe, expect, it } from "vitest";

import { LINK_CHIP_ICONS } from "@/core/editor/links";

import { LINK_CHIP_ICON_CSS } from "./family-icons";

describe("LINK_CHIP_ICON_CSS", () => {
  const rules = LINK_CHIP_ICON_CSS.split("\n");

  it("gives every chip the generic document first, so a family rule always wins", () => {
    expect(rules[0]).toMatch(/^:is\(\[data-link-chip\],a:has\(\[data-link-chip-part\]\)\)\{/);
  });

  it("draws every family a chip can name, on the chip and on the Editor's anchor", () => {
    for (const icon of LINK_CHIP_ICONS) {
      expect(rules).toContainEqual(
        expect.stringContaining(
          `:is([data-link-chip-icon="${icon}"],a:has([data-link-chip-icon="${icon}"]))`,
        ),
      );
    }
    expect(rules).toHaveLength(LINK_CHIP_ICONS.length + 1);
  });

  it("encodes each image so it cannot break out of the style element", () => {
    expect(LINK_CHIP_ICON_CSS).not.toMatch(/<\/?(svg|style|path)/i);
  });
});
