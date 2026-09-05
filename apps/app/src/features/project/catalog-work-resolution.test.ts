/** Catalog Work policy keeps loading, failure, empty, and active states distinct. */
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it } from "vitest";
import { resolveCatalogWork } from "./catalog-work-resolution";

const work = (id: string, status: Work["status"]): Work => ({ id, status }) as Work;

describe("resolveCatalogWork", () => {
  it.each(["loading", "error"] as const)("preserves %s", (status) => {
    expect(resolveCatalogWork({ status })).toEqual({ status });
  });

  it("preserves an authoritative empty catalog", () => {
    expect(resolveCatalogWork({ status: "ready", works: [] })).toEqual({ status: "empty" });
  });

  it("prefers the first active Work over earlier archived rows", () => {
    const archived = work("archived", "archived");
    const active = work("active", "active");
    expect(resolveCatalogWork({ status: "ready", works: [archived, active] })).toEqual({
      status: "ready",
      work: active,
    });
  });

  it("does not resurrect an archived Work as a fallback", () => {
    const archived = work("archived", "archived");
    expect(resolveCatalogWork({ status: "ready", works: [archived] })).toEqual({ status: "empty" });
  });
});
