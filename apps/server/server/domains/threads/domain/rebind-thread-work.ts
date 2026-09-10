/** Canonical nullable thread Work-rebind command shared by model and writer adapters. */
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import type {
  RebindThreadWorkRequest,
  RebindThreadWorkResult,
  Work,
  WorkBindingReceiptState,
} from "@meridian/contracts/works";
import { WorkLifecycleUnavailableError, type WorkRepository } from "../../projects/index.js";
import type {
  ThreadRepository,
  ThreadWorksRepository,
  WorkContextDeliveryRepository,
} from "../ports/repositories.js";
import {
  ThreadMembershipUnavailableError,
  ThreadWorkProjectMismatchError,
} from "../ports/repositories.js";

export type RebindThreadWorkErrorCode =
  | "thread_unavailable"
  | "target_work_unavailable"
  | "project_mismatch";

export class RebindThreadWorkError extends Error {
  constructor(
    readonly code: RebindThreadWorkErrorCode,
    readonly threadId: ThreadId,
    readonly workId?: WorkId,
  ) {
    super(code.replaceAll("_", " "));
    this.name = "RebindThreadWorkError";
  }
}

interface RebindThreadWorkDeps {
  threads: Pick<ThreadRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "rebindPrimary">;
  works: Pick<WorkRepository, "findById">;
  obligations: Pick<WorkContextDeliveryRepository, "enqueueThread">;
}

export interface RebindThreadWorkInput extends RebindThreadWorkRequest {
  threadId: ThreadId;
}

function receiptState(work: Work | null): WorkBindingReceiptState {
  if (!work) return { kind: "none" };
  return {
    kind: "work",
    workId: work.id,
    workSlug: work.slug,
    name: work.name,
    goal: work.goal,
    description: work.description,
    status: work.status,
  };
}

/** Applies the complete binding transition inside the caller-owned transaction. */
export async function rebindThreadWork(
  deps: RebindThreadWorkDeps,
  input: RebindThreadWorkInput,
): Promise<RebindThreadWorkResult> {
  const thread = await deps.threads.findById(input.threadId);
  if (!thread || thread.deletedAt) {
    throw new RebindThreadWorkError("thread_unavailable", input.threadId);
  }

  const targetWorkId = input.target.kind === "work" ? input.target.workId : null;
  let requestedTarget: Work | null = null;
  if (targetWorkId) {
    requestedTarget = await deps.works.findById(targetWorkId);
    if (!requestedTarget || requestedTarget.deletedAt || requestedTarget.status === "archived") {
      throw new RebindThreadWorkError("target_work_unavailable", input.threadId, targetWorkId);
    }
    if (requestedTarget.projectId !== thread.projectId) {
      throw new RebindThreadWorkError("project_mismatch", input.threadId, targetWorkId);
    }
  }

  let rebound: Awaited<ReturnType<ThreadWorksRepository["rebindPrimary"]>>;
  try {
    rebound = await deps.threadWorks.rebindPrimary(thread.id, targetWorkId);
  } catch (cause) {
    if (cause instanceof ThreadMembershipUnavailableError) {
      throw new RebindThreadWorkError("thread_unavailable", input.threadId);
    }
    if (cause instanceof WorkLifecycleUnavailableError) {
      throw new RebindThreadWorkError("target_work_unavailable", input.threadId, cause.workId);
    }
    if (cause instanceof ThreadWorkProjectMismatchError) {
      throw new RebindThreadWorkError("project_mismatch", input.threadId, cause.workId);
    }
    throw cause;
  }
  const previousWork = rebound.previousWorkId
    ? await deps.works.findById(rebound.previousWorkId)
    : null;
  const targetWork = targetWorkId ? await deps.works.findById(targetWorkId) : null;
  if (targetWorkId && (!targetWork || targetWork.deletedAt || targetWork.status === "archived")) {
    throw new RebindThreadWorkError("target_work_unavailable", input.threadId, targetWorkId);
  }

  const before = receiptState(previousWork);
  const after = receiptState(targetWork);
  if (rebound.changed) await deps.obligations.enqueueThread(thread.id);

  return {
    threadId: thread.id as ThreadId,
    before,
    after,
    changed: rebound.changed,
    receipt: { operation: "switch", category: "binding", before, after, inverse: null },
  };
}
