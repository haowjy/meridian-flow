import { describe, expect, it } from "vitest";
import { dropdownRowVariants, dropdownSearchClass } from "./dropdown-presentation";
import { selectScrollControlClass } from "./select";

describe("compact dropdown pointer policy", () => {
  it("uses only the primary coarse-pointer media feature for target floors", () => {
    const recipes = [dropdownRowVariants(), dropdownSearchClass, selectScrollControlClass];
    for (const recipe of recipes) {
      expect(recipe).toContain("media(pointer:coarse)");
      expect(recipe).not.toMatch(/any-pointer|max-width|min-width/);
    }
  });

  it("keeps identity text lanes in the shared two-pixel stack recipe", () => {
    const identity = dropdownRowVariants({ kind: "identity" });

    expect(identity).toContain("flex-col");
    expect(identity).toContain("items-start");
    expect(identity).toContain("gap-0.5");
  });

  it("left-aligns shared choice rows while allowing trailing state lanes", () => {
    const row = dropdownRowVariants();

    expect(row).toContain("justify-start");
    expect(row).toContain("text-left");
  });
});
