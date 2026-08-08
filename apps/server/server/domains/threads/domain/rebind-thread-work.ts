/** Canonical thread Work-rebind command shared by model and writer adapters. */
import type { ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import type {
  RebindThreadWorkResponse,
  Work,
  WorkContextUpdateStatus,
  WorkReceipt,
  WorkReceiptState,
} from "@meridian/contracts/works";
import type { ProjectPreferencesRepository } from "../../preferences/index.js";
import type { WorkRepository } from "../../projects/index.js";
import {
  type ThreadRepository,
  type ThreadWorksRepository,
  ThreadWorkUnavailableError,
} from "../ports/repositories.js";

export class ThreadWorkRebindUnavailableError extends Error {
  constructor() {
    super("Thread or Work not found");
    this.name = "ThreadWorkRebindUnavailableError";
  }
}

export class MissingPrimaryWorkMembershipError extends Error {
  constructor() {
    super("Conversation has no current Work");
    this.name = "MissingPrimaryWorkMembershipError";
  }
}

export interface ThreadWorkContextUpdates {
  /** Enqueues the durable obligation in the ambient business transaction. */
  threadChanged(threadId: ThreadId): Promise<void>;
  /** Best-effort post-commit delivery. */
  flush(threadId: ThreadId): Promise<void>;
  isPending(threadId: ThreadId): Promise<boolean>;
}

export interface RebindThreadWorkDeps {
  threads: Pick<ThreadRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "rebindPrimary">;
  works: Pick<WorkRepository, "findById">;
  preferences: Pick<ProjectPreferencesRepository, "setCurrentWorkId">;
  contextUpdates: ThreadWorkContextUpdates;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
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
    inverse: changed ? { command: "switch", workId: previousWork.id } : null,
  };
}

async function contextUpdateStatus(
  contextUpdates: ThreadWorkContextUpdates,
  threadId: ThreadId,
): Promise<Exclude<WorkContextUpdateStatus, "not_required">> {
  try {
    await contextUpdates.flush(threadId);
  } catch {
    // The durable obligation is the authority. Delivery errors cannot turn a
    // committed binding transition into a failed request.
  }
  return (await contextUpdates.isPending(threadId)) ? "pending" : "delivered";
}

/**
 * Rebinds one thread in a single transaction with sticky-primary preference
 * and durable context-refresh obligation, then attempts delivery after commit.
 */
export async function rebindThreadWork(
  deps: RebindThreadWorkDeps,
  input: RebindThreadWorkInput,
): Promise<RebindThreadWorkResponse> {
  const transition = await deps.transaction(async () => {
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
      throw new ThreadWorkRebindUnavailableError();
    }

    let rebound: Awaited<ReturnType<ThreadWorksRepository["rebindPrimary"]>>;
    try {
      rebound = await deps.threadWorks.rebindPrimary(thread.id, requestedTarget.id);
    } catch (cause) {
      // Lifecycle races are intentionally concealed at both external adapters.
      // Preserve integrity failures that do not describe resource availability.
      if (cause instanceof ThreadWorkUnavailableError) {
        throw new ThreadWorkRebindUnavailableError();
      }
      throw cause;
    }
    if (!rebound.previousWorkId) throw new MissingPrimaryWorkMembershipError();

    const [previousWork, targetWork] = await Promise.all([
      deps.works.findById(rebound.previousWorkId),
      deps.works.findById(requestedTarget.id),
    ]);
    if (!previousWork || !targetWork || targetWork.deletedAt) {
      throw new ThreadWorkRebindUnavailableError();
    }

    const preferenceChanged = rebound.changed && thread.kind === "primary";
    if (preferenceChanged) {
      await deps.preferences.setCurrentWorkId(
        input.preferenceUserId,
        thread.projectId as ProjectId,
        targetWork.id,
      );
    }
    if (rebound.changed) await deps.contextUpdates.threadChanged(thread.id);

    return {
      threadId: thread.id as ThreadId,
      previousWorkId: previousWork.id,
      work: targetWork,
      changed: rebound.changed,
      preferenceChanged,
      receipt: receipt(previousWork, targetWork, rebound.changed),
    };
  });

  return {
    ...transition,
    contextUpdate: transition.changed
      ? await contextUpdateStatus(deps.contextUpdates, transition.threadId)
      : "not_required",
  };
}
