/** D18: pending drafts block primary Work reassignment at the domain boundary. */
import type { WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it, vi } from "vitest";
import {
  PendingDraftWorkReassignmentError,
  reassignThreadPrimaryWork,
} from "./work-reassignment.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
const OLD_WORK_ID = "00000000-0000-4000-8000-000000000003" as WorkId;
const NEW_WORK_ID = "00000000-0000-4000-8000-000000000004" as WorkId;
const target = {
  id: NEW_WORK_ID,
  projectId: PROJECT_ID,
  deletedAt: null,
} as Work;
const withOldPrimaryLock = async <T>(
  _threadId: string,
  operation: (primary: { workId: WorkId } | null) => Promise<T>,
): Promise<T> => operation({ workId: OLD_WORK_ID });

describe("reassignThreadPrimaryWork", () => {
  it("explains that the pending draft belongs to the conversation's Work", () => {
    expect(new PendingDraftWorkReassignmentError().message).toBe(
      "This conversation's Work has an unreviewed draft. Review it before moving the conversation.",
    );
  });

  it("rejects reassignment while the current Work has an unreviewed draft", async () => {
    const addMembership = vi.fn();

    await expect(
      reassignThreadPrimaryWork(
        {
          works: {
            findById: async () => target,
            hasUnreviewedDraft: async () => true,
          },
          threadWorks: {
            withPrimaryWorkLock: withOldPrimaryLock,
            addMembership,
          } as never,
        },
        { threadId: THREAD_ID, projectId: PROJECT_ID, workId: NEW_WORK_ID },
      ),
    ).rejects.toEqual(new PendingDraftWorkReassignmentError());
    expect(addMembership).not.toHaveBeenCalled();
  });

  it("requests primary membership replacement after review", async () => {
    const addMembership = vi.fn();

    await expect(
      reassignThreadPrimaryWork(
        {
          works: {
            findById: async () => target,
            hasUnreviewedDraft: async () => false,
          },
          threadWorks: {
            withPrimaryWorkLock: withOldPrimaryLock,
            addMembership,
          } as never,
        },
        { threadId: THREAD_ID, projectId: PROJECT_ID, workId: NEW_WORK_ID },
      ),
    ).resolves.toEqual({ workId: NEW_WORK_ID });
    expect(addMembership).toHaveBeenCalledWith(THREAD_ID, NEW_WORK_ID, true);
  });
});
