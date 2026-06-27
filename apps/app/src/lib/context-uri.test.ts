import { describe, expect, it } from "vitest";

import { contextRouteTargetFromUri } from "@/lib/context-uri";

describe("contextRouteTargetFromUri", () => {
  it("maps non-work canonical URIs to route path tuples", () => {
    expect(contextRouteTargetFromUri("manuscript://arc/chapter-1.mdx", null)).toEqual({
      scheme: "manuscript",
      path: "/arc/chapter-1.mdx",
      workId: null,
    });
    expect(contextRouteTargetFromUri("kb://world/rules.md", null)).toEqual({
      scheme: "kb",
      path: "/world/rules.md",
      workId: null,
    });
  });

  it("strips the work URI authority from work-scoped route paths", () => {
    expect(contextRouteTargetFromUri("work://work-1/notes/beat.md", "work-1")).toEqual({
      scheme: "work",
      path: "/notes/beat.md",
      workId: "work-1",
    });
  });

  it("degrades when a work-scoped URI does not belong to the active work", () => {
    expect(contextRouteTargetFromUri("work://other/notes/beat.md", "work-1")).toBeNull();
  });
});
