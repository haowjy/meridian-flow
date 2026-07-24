import {
  type ComponentRegistry,
  createAssetPathResolver,
  documentComponentRegistry,
} from "@meridian/markup";
import { describe, expect, it } from "vitest";

import {
  registryAllowedTags,
  registryRenderPlan,
  resolveDocumentImageSource,
} from "./registry-markdown";

describe("registry markdown mapping", () => {
  it("maps registry kinds and props into Streamdown's allowlist", () => {
    const registry = {
      ...documentComponentRegistry,
      Aside: {
        name: "Aside",
        kind: "container",
        children: "block",
        props: { tone: { type: "string" } },
      },
      Badge: {
        name: "Badge",
        kind: "leaf",
        children: "none",
        props: { label: { type: "string" } },
      },
    } as const satisfies ComponentRegistry;

    const plan = registryRenderPlan(registry);

    expect(plan.map(({ componentName, kind }) => [componentName, kind])).toEqual([
      ["Figure", "leaf"],
      ["Layout", "container"],
      ["Aside", "container"],
      ["Badge", "leaf"],
    ]);
    expect(registryAllowedTags(plan)).toEqual({
      figure: ["src", "alt", "label", "caption"],
      layout: ["align", "widths"],
      aside: ["tone"],
      badge: ["label"],
    });
  });

  it("resolves project-relative asset paths without changing external URLs", () => {
    const resolver = createAssetPathResolver([["map-id", "assets/map.png"]]);

    expect(resolveDocumentImageSource("assets/map.png", resolver)).toBe("asset:map-id");
    expect(resolveDocumentImageSource("asset:map-id", resolver)).toBe("asset:map-id");
    expect(resolveDocumentImageSource("https://example.com/map.png", resolver)).toBe(
      "https://example.com/map.png",
    );
    expect(resolveDocumentImageSource("assets/missing.png", resolver)).toBeNull();
  });
});
