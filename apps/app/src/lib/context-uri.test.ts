import { describe, expect, it } from "vitest";

import { canOpenContextUri, contextRouteTargetFromUri } from "@/lib/context-uri";

const WORK_ID = "123e4567-e89b-12d3-a456-426614174000";
const ACTIVE_WORK = { id: WORK_ID, slug: "revision-pass" };

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
    expect(contextRouteTargetFromUri("scratch://probe-cycle-3.mdx", ACTIVE_WORK)).toEqual({
      scheme: "scratch",
      path: "/probe-cycle-3.mdx",
      workId: WORK_ID,
    });
  });

  it("strips an explicit Work slug qualifier that matches the active work", () => {
    expect(
      contextRouteTargetFromUri("scratch://@revision-pass/notes/beat.md", ACTIVE_WORK),
    ).toEqual({
      scheme: "scratch",
      path: "/notes/beat.md",
      workId: WORK_ID,
    });
  });

  it("treats an unqualified UUID segment as a path, never as URI authority", () => {
    expect(contextRouteTargetFromUri(`scratch://${WORK_ID}/notes/beat.md`, ACTIVE_WORK)).toEqual({
      scheme: "scratch",
      path: `/${WORK_ID}/notes/beat.md`,
      workId: WORK_ID,
    });
  });

  it("degrades when an explicit work authority does not belong to the active work", () => {
    expect(
      contextRouteTargetFromUri("scratch://@other-work/notes/beat.md", ACTIVE_WORK),
    ).toBeNull();
  });

  it("routes contextual scratch to the unassigned source when no Work is displayed", () => {
    expect(contextRouteTargetFromUri("scratch://probe-cycle-3.mdx", null)).toEqual({
      scheme: "scratch",
      path: "/probe-cycle-3.mdx",
      workId: null,
    });
  });

  it("resolves an explicit same-project authority from the supplied Work catalog", () => {
    expect(
      contextRouteTargetFromUri("uploads://@other-work/reference.pdf", ACTIVE_WORK, [
        ACTIVE_WORK,
        { id: "work-2", slug: "other-work" },
      ]),
    ).toEqual({ scheme: "uploads", path: "/reference.pdf", workId: "work-2" });
  });
});

describe("canOpenContextUri", () => {
  it("uses the same work-aware resolution policy as navigation", () => {
    expect(canOpenContextUri("manuscript://arc/chapter-1.mdx", null)).toBe(true);
    expect(canOpenContextUri("scratch://notes/beat.md", ACTIVE_WORK)).toBe(true);
    expect(canOpenContextUri("scratch://notes/beat.md", null)).toBe(true);
    expect(canOpenContextUri("scratch://@other-work/notes/beat.md", ACTIVE_WORK)).toBe(false);
  });
});
