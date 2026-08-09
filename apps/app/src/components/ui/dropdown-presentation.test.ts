import { describe, expect, it } from "vitest";
import { dropdownRowVariants, dropdownSearchClass } from "./dropdown-presentation";

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
});
