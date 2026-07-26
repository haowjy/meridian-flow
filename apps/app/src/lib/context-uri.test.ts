import { describe, expect, it } from "vitest";

import { canOpenContextUri, contextRouteTargetFromUri } from "@/lib/context-uri";

const WORK_ID = "123e4567-e89b-12d3-a456-426614174000";
const OTHER_WORK_ID = "00000000-0000-4000-8000-000000000000";

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

  it("resolves a bare scratch URI against the displayed work", () => {
    expect(contextRouteTargetFromUri("scratch://probe-cycle-3.mdx", WORK_ID)).toEqual({
      scheme: "scratch",
      path: "/probe-cycle-3.mdx",
      workId: WORK_ID,
    });
  });

  it("strips an explicit UUID work authority that matches the active work", () => {
    expect(contextRouteTargetFromUri(`scratch://${WORK_ID}/notes/beat.md`, WORK_ID)).toEqual({
      scheme: "scratch",
      path: "/notes/beat.md",
      workId: WORK_ID,
    });
  });

  it("degrades when an explicit work authority does not belong to the active work", () => {
    expect(
      contextRouteTargetFromUri(`scratch://${OTHER_WORK_ID}/notes/beat.md`, WORK_ID),
    ).toBeNull();
  });

  it("degrades a bare scratch URI when there is no displayed work", () => {
    expect(contextRouteTargetFromUri("scratch://probe-cycle-3.mdx", null)).toBeNull();
  });
});

describe("canOpenContextUri", () => {
  it("uses the same work-aware resolution policy as navigation", () => {
    expect(canOpenContextUri("manuscript://arc/chapter-1.mdx", null)).toBe(true);
    expect(canOpenContextUri("scratch://notes/beat.md", WORK_ID)).toBe(true);
    expect(canOpenContextUri("scratch://notes/beat.md", null)).toBe(false);
    expect(canOpenContextUri(`scratch://${OTHER_WORK_ID}/notes/beat.md`, WORK_ID)).toBe(false);
  });
});
