/** Primary Work reassignment policy, including the pending-draft guard. */
import type { ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import type { ThreadWorksRepository } from "../ports/repositories.js";

interface WorkReassignmentRepository {
  findById(id: WorkId): Promise<Work | null>;
  hasUnreviewedDraft(id: WorkId): Promise<boolean>;
}

export class PendingDraftWorkReassignmentError extends Error {
  constructor() {
    super(
      "This conversation's Work has an unreviewed draft. Review it before moving the conversation.",
    );
    this.name = "PendingDraftWorkReassignmentError";
  }
}

export class InvalidThreadWorkTargetError extends Error {
  constructor() {
    super("Work is not available in this project");
    this.name = "InvalidThreadWorkTargetError";
  }
}

export async function reassignThreadPrimaryWork(
  deps: {
    works: WorkReassignmentRepository;
    threadWorks: ThreadWorksRepository;
  },
  input: {
    threadId: ThreadId;
    projectId: ProjectId;
    workId: WorkId;
  },
): Promise<{ workId: WorkId }> {
  const target = await deps.works.findById(input.workId);
  if (!target || target.deletedAt || target.projectId !== input.projectId) {
    throw new InvalidThreadWorkTargetError();
  }

  const current = await deps.threadWorks.findPrimary(input.threadId);
  if (!current) throw new InvalidThreadWorkTargetError();
  if (current.workId === input.workId) return { workId: input.workId };

  if (await deps.works.hasUnreviewedDraft(current.workId)) {
    throw new PendingDraftWorkReassignmentError();
  }

  // addMembership's primary path demotes the old primary and upserts the new
  // one in a single repository transaction.
  await deps.threadWorks.addMembership(input.threadId, input.workId, true);
  return { workId: input.workId };
}
