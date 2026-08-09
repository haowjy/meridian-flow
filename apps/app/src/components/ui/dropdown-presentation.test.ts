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
});
