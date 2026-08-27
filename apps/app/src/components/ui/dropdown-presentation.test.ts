import { describe, expect, it } from "vitest";
import {
  dropdownRowContainerClass,
  dropdownRowVariants,
  dropdownSearchClass,
  dropdownSurfaceVariants,
  dropdownThreadRegionVariants,
} from "./dropdown-presentation";
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

  it("leaves horizontal highlight geometry to rows in every row-bearing region", () => {
    const rowRegions = [
      dropdownSurfaceVariants({ page: "navigation" }),
      dropdownSurfaceVariants({ page: "picker" }),
      dropdownThreadRegionVariants({ region: "results" }),
      dropdownThreadRegionVariants({ region: "footer" }),
    ];

    for (const region of rowRegions) {
      expect(region).toMatch(/(?:^|\s)py-/);
      expect(region).toMatch(/(?:^|\s)px-0(?:\s|$)/);
      expect(region).not.toMatch(/(?:^|\s)(?:p|px)-(?!0(?:\s|$))/);
    }
    expect(dropdownRowVariants()).toMatch(/(?:^|\s)px-2(?:\s|$)/);
  });

  it("delegates direct and composite row focus to the shared square-edge utility", () => {
    const row = dropdownRowVariants();

    expect(row).toContain("dropdown-focus-ring");
    expect(row).toMatch(/(?:^|\s)rounded-none(?:\s|$)/);
    expect(dropdownRowContainerClass).toContain("dropdown-focus-ring");
    expect(dropdownRowContainerClass).toMatch(/(?:^|\s)rounded-none(?:\s|$)/);
    expect(row).not.toMatch(/(?:^|\s)focus-ring(?:\s|$)/);
  });
});
