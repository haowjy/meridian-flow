import { describe, expect, it } from "vitest";

import { contextRouteTargetFromUri, displayContextPath } from "@/lib/context-uri";

const WORK_ID = "123e4567-e89b-12d3-a456-426614174000";
const OTHER_WORK_ID = "00000000-0000-4000-8000-000000000000";

describe("displayContextPath", () => {
  it("keeps the filename of a bare work URI (no UUID authority)", () => {
    // Regression: bare `work://<file>` must not treat the filename as a Work-id
    // authority, which previously produced an empty display path / unlabeled link.
    expect(displayContextPath("work://probe-cycle-3.mdx", "fallback")).toBe("/probe-cycle-3.mdx");
  });

  it("strips a real UUID work authority from the display path", () => {
    expect(displayContextPath(`work://${WORK_ID}/notes/beat.md`, "fallback")).toBe(
      "/notes/beat.md",
    );
  });
});

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

  it("resolves a bare work URI against the displayed work", () => {
    expect(contextRouteTargetFromUri("work://probe-cycle-3.mdx", WORK_ID)).toEqual({
      scheme: "work",
      path: "/probe-cycle-3.mdx",
      workId: WORK_ID,
    });
  });

  it("strips an explicit UUID work authority that matches the active work", () => {
    expect(contextRouteTargetFromUri(`work://${WORK_ID}/notes/beat.md`, WORK_ID)).toEqual({
      scheme: "work",
      path: "/notes/beat.md",
      workId: WORK_ID,
    });
  });

  it("degrades when an explicit work authority does not belong to the active work", () => {
    expect(contextRouteTargetFromUri(`work://${OTHER_WORK_ID}/notes/beat.md`, WORK_ID)).toBeNull();
  });

  it("degrades a bare work URI when there is no displayed work", () => {
    expect(contextRouteTargetFromUri("work://probe-cycle-3.mdx", null)).toBeNull();
  });
});
