/** Canonical thread Work-rebind command shared by model and writer adapters. */
import type { ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import type {
  RebindThreadWorkResult,
  Work,
  WorkReceipt,
  WorkReceiptState,
} from "@meridian/contracts/works";
import type { ProjectPreferencesRepository } from "../../preferences/index.js";
import { WorkLifecycleUnavailableError, type WorkRepository } from "../../projects/index.js";
import type {
  ThreadRepository,
  ThreadWorksRepository,
  WorkContextDeliveryRepository,
} from "../ports/repositories.js";

type RebindThreadWorkErrorReason = "unavailable" | "missing_primary";

export class RebindThreadWorkError extends Error {
  constructor(
    readonly reason: RebindThreadWorkErrorReason,
    readonly threadId: ThreadId,
  ) {
    super(
      reason === "unavailable" ? "Thread or Work not found" : "Conversation has no current Work",
    );
    this.name = "RebindThreadWorkError";
  }
}

interface RebindThreadWorkDeps {
  threads: Pick<ThreadRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "rebindPrimary">;
  works: Pick<WorkRepository, "findById">;
  preferences: Pick<ProjectPreferencesRepository, "setCurrentWorkId">;
  obligations: Pick<WorkContextDeliveryRepository, "enqueueThread">;
}

export interface RebindThreadWorkInput {
  threadId: ThreadId;
  targetWorkId: WorkId;
  preferenceUserId: UserId;
}

function receiptState(work: Work): WorkReceiptState {
  return {
    name: work.name,
    goal: work.goal,
    description: work.description,
    status: work.status,
  };
}

function receipt(previousWork: Work, targetWork: Work, changed: boolean): WorkReceipt {
  return {
    operation: "switch",
    category: "binding",
    changed,
    workId: targetWork.id,
    workName: targetWork.name,
    before: receiptState(previousWork),
    after: receiptState(targetWork),
    inverse: null,
  };
}

/** Applies the complete binding transition inside the caller-owned transaction. */
export async function rebindThreadWork(
  deps: RebindThreadWorkDeps,
  input: RebindThreadWorkInput,
): Promise<RebindThreadWorkResult> {
  const [thread, requestedTarget] = await Promise.all([
    deps.threads.findById(input.threadId),
    deps.works.findById(input.targetWorkId),
  ]);
  if (
    !thread ||
    thread.deletedAt ||
    !requestedTarget ||
    requestedTarget.deletedAt ||
    requestedTarget.projectId !== thread.projectId
  ) {
    throw new RebindThreadWorkError("unavailable", input.threadId);
  }

  const rebound = await deps.threadWorks.rebindPrimary(thread.id, requestedTarget.id);
  if (!rebound.previousWorkId) {
    throw new RebindThreadWorkError("missing_primary", input.threadId);
  }

  const [previousWork, targetWork] = await Promise.all([
    deps.works.findById(rebound.previousWorkId),
    deps.works.findById(requestedTarget.id),
  ]);
  if (!previousWork || previousWork.deletedAt) {
    throw new RebindThreadWorkError("missing_primary", input.threadId);
  }
  if (!targetWork || targetWork.deletedAt) {
    throw new WorkLifecycleUnavailableError(requestedTarget.id, targetWork ? "deleted" : "missing");
  }

  const preferenceChanged = rebound.changed && thread.kind === "primary";
  if (preferenceChanged) {
    await deps.preferences.setCurrentWorkId(
      input.preferenceUserId,
      thread.projectId as ProjectId,
      targetWork.id,
    );
  }
  if (rebound.changed) await deps.obligations.enqueueThread(thread.id);

  return {
    threadId: thread.id as ThreadId,
    previousWorkId: previousWork.id,
    work: targetWork,
    changed: rebound.changed,
    preferenceChanged,
    receipt: receipt(previousWork, targetWork, rebound.changed),
  };
}
