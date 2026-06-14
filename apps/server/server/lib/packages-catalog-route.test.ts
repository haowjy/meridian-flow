// @ts-nocheck
/** Route-core tests for the first-party package catalog. */
import { describe, expect, it } from "vitest";
import { handleGetPackagesCatalogRequest } from "./packages-catalog-route.js";

describe("packages catalog route core", () => {
  it("returns the promoted first-party package list", () => {
    const response = handleGetPackagesCatalogRequest();
    expect(response.packages.map((pkg) => pkg.id)).toEqual([
      "literature-review",
      "data-analysis",
      "lab-notebook",
      "protocol-designer",
    ]);
    expect(response.packages[0]).toMatchObject({
      name: "Literature Review",
      description: expect.any(String),
    });
  });
});
