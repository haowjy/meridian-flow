import type { ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it } from "vitest";
import { testWorkSlug } from "../../../test-support/work-slug.js";
import { createWorkContextReader, renderWorkContext } from "./work-context.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000301" as ProjectId;
const THREAD_ID = "00000000-0000-4000-8000-000000000302" as ThreadId;
const WORK_ID = "00000000-0000-4000-8000-000000000303" as WorkId;
const NO_WORK_ID = "00000000-0000-4000-8000-000000000304" as WorkId;
const USER_ID = "00000000-0000-4000-8000-000000000305";

function work(overrides: Partial<Work> & Pick<Work, "id" | "name">): Work {
  return {
    projectId: PROJECT_ID,
    createdByUserId: USER_ID,
    slug: testWorkSlug(overrides.name.toLowerCase().replaceAll(" ", "-")),
    isNoWork: false,
    goal: null,
    description: null,
    status: "active",
    archivedAt: null,
    aiWriteMode: "direct",
    entityRevision: "1",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    lastActivityAt: "2026-08-08T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

describe("renderWorkContext", () => {
  it("bakes No Work current from the row's write mode", () => {
    const locked = work({
      id: NO_WORK_ID,
      name: "No Work",
      slug: null,
      isNoWork: true,
      aiWriteMode: "draft",
    });
    const named = work({
      id: WORK_ID,
      name: "Arc",
      lastActivityAt: "2026-08-09T00:00:00.000Z",
    });
    expect(renderWorkContext({ current: locked, activeWorks: [locked, named] })).toBe(
      [
        "<work_context>",
        "current: none (draft writes)",
        "active (most recent first; max 20):",
        '  arc: "Arc" (goal: none)',
        "</work_context>",
      ].join("\n"),
    );
  });
});

describe("createWorkContextReader", () => {
  it("treats a missing primary as corrupt", async () => {
    const reader = createWorkContextReader({
      threads: {
        findById: async () =>
          ({
            id: THREAD_ID,
            projectId: PROJECT_ID,
            deletedAt: null,
          }) as never,
      },
      works: {
        findById: async () => null,
        listByProject: async () => [],
      },
      threadWorks: { findPrimary: async () => null },
    });
    await expect(reader.renderForThread(THREAD_ID)).rejects.toThrow(
      `Thread primary Work is missing: ${THREAD_ID}`,
    );
  });
});
