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

  it("maps a chat's Scratch to its lineage, however the URI is spelled", () => {
    const lineages = {
      own: "root-c12",
      idForRef: (ref: string) => ({ c12: "root-c12", c40: "root-c40" })[ref] ?? null,
    };
    const route = (uri: string, active: { id: string; slug: string | null } = NO_WORK) =>
      contextRouteTargetFromUri(uri, active, [ACTIVE_WORK], NO_WORK.id, lineages);
    // Bare means the chat's own lineage; there is no No Work Scratch to stand in for one.
    expect(route("scratch://probe-cycle-3.mdx")).toEqual({
      scheme: "scratch",
      path: "/probe-cycle-3.mdx",
      workId: null,
      rootThreadId: "root-c12",
    });
    expect(
      contextRouteTargetFromUri("scratch://probe-cycle-3.mdx", NO_WORK, [ACTIVE_WORK], NO_WORK.id),
    ).toBeNull();
    // A canonical handle names another chat's lineage from any chat; an unknown handle routes nowhere.
    for (const active of [NO_WORK, ACTIVE_WORK])
      expect(route("scratch://@/c40/duel/beats.md", active)).toMatchObject({
        workId: null,
        rootThreadId: "root-c40",
      });
    expect(route("scratch://@/c99/x.md")).toBeNull();
    // A named-Work chat's bare Scratch stays in its Work.
    expect(route("scratch://x.md", ACTIVE_WORK)).toEqual({
      scheme: "scratch",
      path: "/x.md",
      workId: WORK_ID,
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
