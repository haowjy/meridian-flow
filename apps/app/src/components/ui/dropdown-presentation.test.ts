import { describe, expect, it } from "vitest";
import {
  densityPopoverCollisionProps,
  dropdownRowVariants,
  dropdownSearchClass,
  dropdownSurfaceVariants,
} from "./dropdown-presentation";
import { selectScrollControlClass } from "./select";

describe("compact dropdown presentation", () => {
  it("keeps fine rows compact with a real coarse-pointer floor", () => {
    expect(dropdownRowVariants({ kind: "navigation" })).toContain("h-8");
    expect(dropdownRowVariants({ kind: "navigation" })).toContain("[@media(pointer:coarse)]:h-11");
    expect(dropdownSearchClass).toContain("[@media(pointer:coarse)]:h-11");
  });

  it("does not give status rows interactive state styling", () => {
    const status = dropdownRowVariants({ interactive: false });
    expect(status).not.toContain("hover:");
    expect(status).not.toContain("focus-ring");
  });

  it("exposes neutral selection independently of interaction semantics", () => {
    expect(dropdownRowVariants({ selected: true })).toContain("bg-sidebar-accent");
  });

  it("normalizes Button-backed rows without changing selected emphasis", () => {
    const row = dropdownRowVariants();
    expect(row).toContain("has-[>svg]:px-2");
    expect(row).toContain("font-normal");
    expect(row).toContain("active:scale-100");
    expect(dropdownRowVariants({ selected: true })).toContain("font-medium");
  });

  it("keeps page padding semantic and shares the density collision gutter", () => {
    expect(dropdownSurfaceVariants({ page: "navigation" })).toContain("p-1");
    expect(dropdownSurfaceVariants({ page: "picker" })).toContain("p-2");
    expect(densityPopoverCollisionProps).toEqual({ collisionPadding: 8 });
  });

  it("gives Select scroll controls a coarse target without enlarging the glyph", () => {
    expect(selectScrollControlClass).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(selectScrollControlClass).toContain("focus-ring");
  });
});
