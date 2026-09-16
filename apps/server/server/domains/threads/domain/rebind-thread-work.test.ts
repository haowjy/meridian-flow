import type { ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it, vi } from "vitest";
import { ThreadMembershipUnavailableError } from "../ports/repositories.js";
import { rebindThreadWork } from "./rebind-thread-work.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000101" as ThreadId;
const SOURCE_ID = "00000000-0000-4000-8000-000000000102" as WorkId;
const TARGET_ID = "00000000-0000-4000-8000-000000000103" as WorkId;
const USER_ID = "00000000-0000-4000-8000-000000000104" as UserId;

function work(id: WorkId, name: string, projectId = "project-1"): Work {
  return {
    id,
    projectId,
    createdByUserId: USER_ID,
    name,
    slug: name.toLowerCase(),
    goal: null,
    description: null,
    status: "active",
    archivedAt: null,
    aiWriteMode: "direct",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    lastActivityAt: "2026-08-08T00:00:00.000Z",
    deletedAt: null,
  } as Work;
}

function fixture(
  initial: WorkId | null = SOURCE_ID,
  target: Work | null = work(TARGET_ID, "Target"),
) {
  const source = work(SOURCE_ID, "Source");
  let current = initial;
  const enqueueThread = vi.fn(async () => [THREAD_ID]);
  const deps = {
    threads: {
      findById: async () =>
        ({ id: THREAD_ID, projectId: "project-1", userId: USER_ID, deletedAt: null }) as Thread,
    },
    works: {
      findById: async (id: WorkId) =>
        id === SOURCE_ID ? source : id === TARGET_ID ? target : null,
    },
    threadWorks: {
      rebindPrimary: async (_threadId: ThreadId, next: WorkId | null) => {
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
  it.each([
    [SOURCE_ID, { kind: "none" } as const, "work", "none", true],
    [null, { kind: "work", workId: TARGET_ID } as const, "none", "work", true],
    [null, { kind: "none" } as const, "none", "none", false],
  ])("rebinds nullable scope with a factual receipt", async (initial, target, before, after, changed) => {
    const h = fixture(initial);
    const result = await rebindThreadWork(h.deps, { threadId: THREAD_ID, target });
    expect(result).toMatchObject({
      changed,
      before: { kind: before },
      after: { kind: after },
      receipt: { before: { kind: before }, after: { kind: after }, inverse: null },
    });
    expect(h.enqueueThread).toHaveBeenCalledTimes(changed ? 1 : 0);
  });

  it.each([
    [null, "target_work_unavailable"],
    [{ ...work(TARGET_ID, "Deleted"), deletedAt: "now" }, "target_work_unavailable"],
    [work(TARGET_ID, "Other", "project-2"), "project_mismatch"],
  ])("returns a typed target error", async (target, code) => {
    await expect(
      rebindThreadWork(fixture(null, target).deps, {
        threadId: THREAD_ID,
        target: { kind: "work", workId: TARGET_ID },
      }),
    ).rejects.toEqual(expect.objectContaining({ name: "RebindThreadWorkError", code }));
  });

  it("translates a lifecycle loss under the membership lock", async () => {
    const h = fixture(null);
    h.deps.threadWorks.rebindPrimary = async () => {
      throw new ThreadMembershipUnavailableError(THREAD_ID);
    };
    await expect(
      rebindThreadWork(h.deps, {
        threadId: THREAD_ID,
        target: { kind: "work", workId: TARGET_ID },
      }),
    ).rejects.toMatchObject({ name: "RebindThreadWorkError", code: "thread_unavailable" });
  });
});
