/** Behavioral coverage for the shared thread Work-rebind transaction. */
import type { ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it, vi } from "vitest";
import { RebindThreadWorkError, rebindThreadWork } from "./rebind-thread-work.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000101" as ThreadId;
const SOURCE_ID = "00000000-0000-4000-8000-000000000102" as WorkId;
const TARGET_ID = "00000000-0000-4000-8000-000000000103" as WorkId;
const USER_ID = "00000000-0000-4000-8000-000000000104" as UserId;
const PREFERENCE_USER_ID = "00000000-0000-4000-8000-000000000105" as UserId;

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
  options: {
    kind?: Thread["kind"];
    target?: Work | null;
    sameTarget?: boolean;
    missingPrimary?: boolean;
  } = {},
) {
  const source = work(SOURCE_ID, "Source");
  const target = options.target === undefined ? work(TARGET_ID, "Target") : options.target;
  let currentId = options.sameTarget ? TARGET_ID : SOURCE_ID;
  const setCurrentWorkId = vi.fn(async () => {});
  const enqueueThread = vi.fn(async () => [THREAD_ID]);
  const thread = {
    id: THREAD_ID,
    projectId: "project-1",
    userId: USER_ID,
    kind: options.kind ?? "primary",
    deletedAt: null,
  } as Thread;
  return {
    source,
    target,
    setCurrentWorkId,
    enqueueThread,
    deps: {
      threads: { findById: async () => thread },
      works: {
        findById: async (id: WorkId) =>
          id === SOURCE_ID ? source : id === TARGET_ID ? target : null,
      },
      threadWorks: {
        rebindPrimary: async (_threadId: ThreadId, workId: WorkId) => {
          if (options.missingPrimary) return { previousWorkId: null, changed: true };
          const previousWorkId = currentId;
          const changed = previousWorkId !== workId;
          currentId = workId;
          return { previousWorkId, changed };
        },
      },
      preferences: { setCurrentWorkId },
      obligations: { enqueueThread },
    },
  };
}

describe("rebindThreadWork", () => {
  it("commits one exact receipt, primary preference, and context-refresh enqueue", async () => {
    const h = fixture();
    const result = await rebindThreadWork(h.deps, {
      threadId: THREAD_ID,
      targetWorkId: TARGET_ID,
      preferenceUserId: PREFERENCE_USER_ID,
    });

    expect(result).toMatchObject({
      threadId: THREAD_ID,
      previousWorkId: SOURCE_ID,
      work: { id: TARGET_ID, name: "Target" },
      changed: true,
      preferenceChanged: true,
      receipt: {
        operation: "switch",
        category: "binding",
        changed: true,
        before: { name: "Source" },
        after: { name: "Target" },
        inverse: null,
      },
    });
    expect(h.setCurrentWorkId).toHaveBeenCalledWith(PREFERENCE_USER_ID, "project-1", TARGET_ID);
    expect(h.enqueueThread).toHaveBeenCalledOnce();
  });

  it("keeps same-target retries side-effect free with no inverse", async () => {
    const h = fixture({ sameTarget: true });
    const result = await rebindThreadWork(h.deps, {
      threadId: THREAD_ID,
      targetWorkId: TARGET_ID,
      preferenceUserId: USER_ID,
    });

    expect(result).toMatchObject({
      changed: false,
      preferenceChanged: false,
      receipt: { changed: false, inverse: null },
    });
    expect(h.setCurrentWorkId).not.toHaveBeenCalled();
    expect(h.enqueueThread).not.toHaveBeenCalled();
  });

  it("does not change sticky preference for subagent threads", async () => {
    const h = fixture({ kind: "subagent" });
    const result = await rebindThreadWork(h.deps, {
      threadId: THREAD_ID,
      targetWorkId: TARGET_ID,
      preferenceUserId: USER_ID,
    });
    expect(result.preferenceChanged).toBe(false);
    expect(h.setCurrentWorkId).not.toHaveBeenCalled();
  });

  it("rejects missing, deleted, and cross-project targets before mutation", async () => {
    for (const target of [
      null,
      { ...work(TARGET_ID, "Deleted"), deletedAt: "now" },
      work(TARGET_ID, "Other", "project-2"),
    ]) {
      const h = fixture({ target });
      await expect(
        rebindThreadWork(h.deps, {
          threadId: THREAD_ID,
          targetWorkId: TARGET_ID,
          preferenceUserId: USER_ID,
        }),
      ).rejects.toBeInstanceOf(RebindThreadWorkError);
      expect(h.enqueueThread).not.toHaveBeenCalled();
    }
  });

  it("preserves missing-primary identity from the binding transition", async () => {
    const h = fixture({ missingPrimary: true });

    await expect(
      rebindThreadWork(h.deps, {
        threadId: THREAD_ID,
        targetWorkId: TARGET_ID,
        preferenceUserId: USER_ID,
      }),
    ).rejects.toMatchObject({
      name: "RebindThreadWorkError",
      reason: "missing_primary",
      threadId: THREAD_ID,
    });
    expect(h.setCurrentWorkId).not.toHaveBeenCalled();
    expect(h.enqueueThread).not.toHaveBeenCalled();
  });
});
