import type { ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it, vi } from "vitest";
import { testWorkSlug } from "../../../test-support/work-slug.js";
import { ThreadMembershipUnavailableError } from "../ports/repositories.js";
import { rebindThreadWork } from "./rebind-thread-work.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000101" as ThreadId;
const SOURCE_ID = "00000000-0000-4000-8000-000000000102" as WorkId;
const TARGET_ID = "00000000-0000-4000-8000-000000000103" as WorkId;
const NO_WORK_ID = "00000000-0000-4000-8000-000000000105" as WorkId;
const USER_ID = "00000000-0000-4000-8000-000000000104" as UserId;

function work(id: WorkId, name: string, projectId = "project-1"): Work {
  return {
    id,
    projectId,
    createdByUserId: USER_ID,
    name,
    slug: testWorkSlug(name.toLowerCase().replaceAll(" ", "-")),
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
  };
}

function noWorkRow(projectId = "project-1"): Work {
  return {
    ...work(NO_WORK_ID, "No Work", projectId),
    slug: null,
    isNoWork: true,
    aiWriteMode: "draft",
  };
}

function fixture(initial: WorkId = SOURCE_ID, target: Work | null = work(TARGET_ID, "Target")) {
  const source = work(SOURCE_ID, "Source");
  const locked = noWorkRow();
  let current: WorkId | null = initial;
  const enqueueThread = vi.fn(async () => [THREAD_ID]);
  const deps = {
    threads: {
      findById: async () =>
        ({ id: THREAD_ID, projectId: "project-1", userId: USER_ID, deletedAt: null }) as Thread,
    },
    works: {
      findById: async (id: WorkId) =>
        id === SOURCE_ID ? source : id === TARGET_ID ? target : id === NO_WORK_ID ? locked : null,
      findNoWork: async () => locked,
    },
    threadWorks: {
      rebindPrimary: async (_threadId: ThreadId, next: WorkId) => {
        const previousWorkId = current;
        const changed = current !== next;
        current = next;
        return { previousWorkId, changed };
      },
    },
    obligations: { enqueueThread },
  };
  return { deps, enqueueThread };
}

describe("rebindThreadWork", () => {
  it("rebinds named Work to No Work with a null slug receipt", async () => {
    const h = fixture(SOURCE_ID);
    const result = await rebindThreadWork(h.deps, { threadId: THREAD_ID, workId: NO_WORK_ID });
    expect(result).toMatchObject({
      changed: true,
      before: { workId: SOURCE_ID, name: "Source", slug: expect.any(String) },
      after: { workId: NO_WORK_ID, name: "No Work", slug: null, aiWriteMode: "draft" },
      receipt: {
        before: { workId: SOURCE_ID },
        after: { workId: NO_WORK_ID, name: "No Work", slug: null, aiWriteMode: "draft" },
        inverse: null,
      },
    });
    expect(h.enqueueThread).toHaveBeenCalledTimes(1);
  });

  it("rebinds No Work to named Work", async () => {
    const h = fixture(NO_WORK_ID);
    const result = await rebindThreadWork(h.deps, { threadId: THREAD_ID, workId: TARGET_ID });
    expect(result).toMatchObject({
      changed: true,
      before: { workId: NO_WORK_ID, name: "No Work", slug: null, aiWriteMode: "draft" },
      after: { workId: TARGET_ID, name: "Target" },
    });
  });

  it("no-ops when already bound to No Work", async () => {
    const h = fixture(NO_WORK_ID);
    const result = await rebindThreadWork(h.deps, { threadId: THREAD_ID, workId: NO_WORK_ID });
    expect(result.changed).toBe(false);
    expect(h.enqueueThread).not.toHaveBeenCalled();
  });

  it.each([
    [null, "target_work_unavailable"],
    [{ ...work(TARGET_ID, "Deleted"), deletedAt: "now" }, "target_work_unavailable"],
    [work(TARGET_ID, "Other", "project-2"), "project_mismatch"],
  ])("returns a typed target error", async (target, code) => {
    await expect(
      rebindThreadWork(fixture(SOURCE_ID, target).deps, {
        threadId: THREAD_ID,
        workId: TARGET_ID,
      }),
    ).rejects.toEqual(expect.objectContaining({ name: "RebindThreadWorkError", code }));
  });

  it("translates a lifecycle loss under the membership lock", async () => {
    const h = fixture(SOURCE_ID);
    h.deps.threadWorks.rebindPrimary = async () => {
      throw new ThreadMembershipUnavailableError(THREAD_ID);
    };
    await expect(
      rebindThreadWork(h.deps, {
        threadId: THREAD_ID,
        workId: TARGET_ID,
      }),
    ).rejects.toMatchObject({ name: "RebindThreadWorkError", code: "thread_unavailable" });
  });
});
