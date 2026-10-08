import { describe, expect, it } from "vitest";

import {
  canOpenContextUri,
  contextRouteTargetFromUri,
  contextUriFromWritePath,
} from "@/lib/context-uri";

const WORK_ID = "123e4567-e89b-12d3-a456-426614174000";
const NO_WORK = { id: "no-work", slug: null };
const ACTIVE_WORK = { id: WORK_ID, slug: "revision-pass" };
const LINEAGES = {
  own: "root-c12",
  idForRef: (ref: string) => ({ c12: "root-c12", c40: "root-c40" })[ref] ?? null,
};

describe("contextRouteTargetFromUri", () => {
  it("maps non-work canonical URIs to route path tuples", () => {
    expect(
      contextRouteTargetFromUri(
        "manuscript://arc/chapter-1.mdx",
        NO_WORK,
        [ACTIVE_WORK],
        NO_WORK.id,
      ),
    ).toEqual({
      scheme: "manuscript",
      path: "/arc/chapter-1.mdx",
      workId: null,
    });
    expect(
      contextRouteTargetFromUri("kb://world/rules.md", NO_WORK, [ACTIVE_WORK], NO_WORK.id),
    ).toEqual({
      scheme: "kb",
      path: "/world/rules.md",
      workId: null,
    });
  });

  it("resolves a bare scratch URI against the displayed work", () => {
    expect(
      contextRouteTargetFromUri(
        "scratch://probe-cycle-3.mdx",
        ACTIVE_WORK,
        [ACTIVE_WORK],
        NO_WORK.id,
      ),
    ).toEqual({
      scheme: "scratch",
      path: "/probe-cycle-3.mdx",
      workId: WORK_ID,
    });
  });

  it("strips an explicit Work slug qualifier that matches the active work", () => {
    expect(
      contextRouteTargetFromUri(
        "scratch://@revision-pass/notes/beat.md",
        ACTIVE_WORK,
        [ACTIVE_WORK],
        NO_WORK.id,
      ),
    ).toEqual({
      scheme: "scratch",
      path: "/notes/beat.md",
      workId: WORK_ID,
    });
  });

  it("treats an unqualified UUID segment as a path, never as URI authority", () => {
    expect(
      contextRouteTargetFromUri(
        `scratch://${WORK_ID}/notes/beat.md`,
        ACTIVE_WORK,
        [ACTIVE_WORK],
        NO_WORK.id,
      ),
    ).toEqual({
      scheme: "scratch",
      path: `/${WORK_ID}/notes/beat.md`,
      workId: WORK_ID,
    });
  });

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

  it("routes contextual Scratch in a No Work chat to the chat's own lineage", () => {
    expect(
      contextRouteTargetFromUri(
        "scratch://probe-cycle-3.mdx",
        NO_WORK,
        [ACTIVE_WORK],
        NO_WORK.id,
        LINEAGES,
      ),
    ).toEqual({
      scheme: "scratch",
      path: "/probe-cycle-3.mdx",
      workId: null,
      rootThreadId: "root-c12",
    });
    // Without a lineage there is no Scratch to open; the row id never stands in for one.
    expect(
      contextRouteTargetFromUri("scratch://probe-cycle-3.mdx", NO_WORK, [ACTIVE_WORK], NO_WORK.id),
    ).toBeNull();
  });

  it("routes a canonical chat URI by the first chat's handle, from any chat", () => {
    for (const activeWork of [NO_WORK, ACTIVE_WORK]) {
      expect(
        contextRouteTargetFromUri(
          "scratch://@/c40/duel/beats.md",
          activeWork,
          [ACTIVE_WORK],
          NO_WORK.id,
          LINEAGES,
        ),
      ).toEqual({
        scheme: "scratch",
        path: "/duel/beats.md",
        workId: null,
        rootThreadId: "root-c40",
      });
    }
    expect(
      contextRouteTargetFromUri(
        "scratch://@/c99/x.md",
        NO_WORK,
        [ACTIVE_WORK],
        NO_WORK.id,
        LINEAGES,
      ),
    ).toBeNull();
  });

  it("keeps a named-Work chat's bare Scratch in its Work and never routes No Work Scratch", () => {
    expect(
      contextRouteTargetFromUri("scratch://x.md", ACTIVE_WORK, [ACTIVE_WORK], NO_WORK.id, LINEAGES),
    ).toEqual({ scheme: "scratch", path: "/x.md", workId: WORK_ID });
    expect(
      contextRouteTargetFromUri("scratch://@/", NO_WORK, [ACTIVE_WORK], NO_WORK.id, LINEAGES),
    ).toBeNull();
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

describe("canOpenContextUri", () => {
  it("uses the same work-aware resolution policy as navigation", () => {
    expect(
      canOpenContextUri("manuscript://arc/chapter-1.mdx", NO_WORK, [ACTIVE_WORK], NO_WORK.id),
    ).toBe(true);
    expect(
      canOpenContextUri("scratch://notes/beat.md", ACTIVE_WORK, [ACTIVE_WORK], NO_WORK.id),
    ).toBe(true);
    expect(
      canOpenContextUri("scratch://notes/beat.md", NO_WORK, [ACTIVE_WORK], NO_WORK.id, LINEAGES),
    ).toBe(true);
    expect(
      canOpenContextUri(
        "scratch://@other-work/notes/beat.md",
        ACTIVE_WORK,
        [ACTIVE_WORK],
        NO_WORK.id,
      ),
    ).toBe(false);
  });
});

describe("contextUriFromWritePath", () => {
  it("files bare paths under the manuscript and never files another scheme there", () => {
    expect(contextUriFromWritePath("ch1.md")).toBe("manuscript://ch1.md");
    expect(contextUriFromWritePath("kb://world/rules.md")).toBe("kb://world/rules.md");
    expect(contextUriFromWritePath("skills://story-review/references/beats.md")).toBeNull();
  });
});
