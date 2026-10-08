import { describe, expect, it } from "vitest";

import { contextRouteTargetFromUri } from "@/lib/context-uri";

const WORK_ID = "123e4567-e89b-12d3-a456-426614174000";
const NO_WORK = { id: "no-work", slug: null };
const ACTIVE_WORK = { id: WORK_ID, slug: "revision-pass" };

describe("contextRouteTargetFromUri", () => {
  it("degrades when an explicit work authority does not belong to the active work", () => {
    expect(
      contextRouteTargetFromUri(
        "scratch://@other-work/notes/beat.md",
        ACTIVE_WORK,
        [ACTIVE_WORK],
        NO_WORK.id,
      ),
    ).toBeNull();
  });

  it("routes contextual Scratch in the No Work Editor by row id", () => {
    expect(
      contextRouteTargetFromUri("scratch://probe-cycle-3.mdx", NO_WORK, [ACTIVE_WORK], NO_WORK.id),
    ).toEqual({
      scheme: "scratch",
      path: "/probe-cycle-3.mdx",
      workId: NO_WORK.id,
    });
  });

  it("resolves an explicit same-project authority from the supplied Work catalog", () => {
    expect(
      contextRouteTargetFromUri(
        "uploads://@other-work/reference.pdf",
        ACTIVE_WORK,
        [ACTIVE_WORK, { id: "work-2", slug: "other-work" }],
        NO_WORK.id,
      ),
    ).toEqual({ scheme: "uploads", path: "/reference.pdf", workId: "work-2" });
  });
});
