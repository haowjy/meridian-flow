import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
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

  it("uses the shared inset dropdown focus treatment without changing ordinary controls", () => {
    const row = dropdownRowVariants();
    const styles = readFileSync(
      fileURLToPath(new URL("../../styles/globals.css", import.meta.url)),
      "utf8",
    );
    const dropdownFocus = styles.match(/@utility dropdown-focus-ring \{(?<body>[\s\S]*?)\n\}/)
      ?.groups?.body;

    expect(row).toContain("dropdown-focus-ring");
    expect(row).not.toMatch(/(?:^|\s)focus-ring(?:\s|$)/);
    expect(dropdownFocus).toContain("inset 0 0 0 2px var(--color-border-focus)");
    expect(dropdownFocus).toContain("inset 0 0 0 4px color-mix(in oklab, var(--color-ring)");
  });
});
