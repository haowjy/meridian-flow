/** Executes typed durable Work receipts through the thread reversal seam. */
import type { ReversalOutcome, WorkReversalResult } from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
import {
  parseWorkReceipt,
  type WorkReceipt,
  type WorkReceiptState,
} from "@meridian/contracts/works";
import type { ProjectPreferencesRepository } from "../domains/preferences/index.js";
import type { WorkContextUpdates, WorkRepository } from "../domains/projects/index.js";
import type {
  BlockRepository,
  ThreadRepository,
  ThreadWorksRepository,
  TurnRepository,
} from "../domains/threads/index.js";

type WorkReceiptReversalDeps = {
  blocks: Pick<BlockRepository, "listByTurn">;
  turns: Pick<TurnRepository, "findById">;
  threads: Pick<ThreadRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary" | "rebindPrimary">;
  preferences: Pick<ProjectPreferencesRepository, "setCurrentWorkId">;
  works: WorkRepository;
  contextUpdates: Pick<WorkContextUpdates, "projectChanged">;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
};

export type WorkReceiptReversal = WorkReversalResult & { workId: WorkId };
type Direction = "undo" | "redo";

export function combineWorkReversalOutcome(
  outcome: ReversalOutcome,
  workReceipts: WorkReceiptReversal[],
  direction: Direction,
): ReversalOutcome {
  if (workReceipts.length === 0) return outcome;
  const succeeded = workReceipts.some((result) =>
    direction === "undo" ? result.status === "reversed" : result.status === "redone",
  );
  const failed = workReceipts.some(
    (result) => result.status === "failed" || result.status === "unavailable",
  );
  return {
    ...outcome,
    status: failed
      ? "partial_failure"
      : succeeded && (outcome.status === "nothing_to_undo" || outcome.status === "nothing_to_redo")
        ? direction === "undo"
          ? "reversed"
          : "reconciled"
        : outcome.status,
    workReceipts,
  };
}

export async function reverseWorkReceipts(
  deps: WorkReceiptReversalDeps,
  input: { threadId: ThreadId; turnId: TurnId; direction: Direction },
): Promise<WorkReceiptReversal[]> {
  const turn = await deps.turns.findById(input.turnId);
  const thread = await deps.threads.findById(input.threadId);
  if (!turn || turn.threadId !== input.threadId || !thread) return [];
  const receipts = await receiptsForTurn(deps, input.turnId);
  const ordered = input.direction === "undo" ? [...receipts].reverse() : receipts;
  const changedProjects = new Set<string>();
  try {
    const results = await deps.transaction(async () => {
      const applied: WorkReceiptReversal[] = [];
      for (const receipt of ordered) {
        applied.push(await applyReceipt(deps, thread, receipt, input.direction, changedProjects));
      }
      return applied;
    });
    await Promise.all(
      [...changedProjects].map((projectId) => deps.contextUpdates.projectChanged(projectId)),
    );
    return results;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return ordered.map((receipt) => ({
      command: receipt.inverse?.command ?? forwardCommand(receipt),
      workId: receipt.workId,
      name: receipt.workName,
      status: "failed",
      message,
    }));
  }
}

export async function getWorkReceiptReversalAvailability(
  deps: Pick<WorkReceiptReversalDeps, "blocks" | "turns" | "works" | "threads" | "threadWorks">,
  input: { threadId: ThreadId; turnId: TurnId },
): Promise<{ undo: boolean; redo: boolean }> {
  const turn = await deps.turns.findById(input.turnId);
  if (!turn || turn.threadId !== input.threadId || !(await deps.threads.findById(input.threadId))) {
    return { undo: false, redo: false };
  }
  const receipts = await receiptsForTurn(deps, input.turnId);
  if (receipts.length === 0) return { undo: false, redo: false };
  return {
    undo: await receiptsExecutable(deps, [...receipts].reverse(), input.threadId, "undo"),
    redo: await receiptsExecutable(deps, receipts, input.threadId, "redo"),
  };
}

async function receiptsForTurn(
  deps: Pick<WorkReceiptReversalDeps, "blocks">,
  turnId: TurnId,
): Promise<WorkReceipt[]> {
  return (await deps.blocks.listByTurn(turnId)).flatMap((block) => {
    const receipt = receiptFromContent(block.content);
    return receipt?.changed ? [receipt] : [];
  });
}

async function receiptsExecutable(
  deps: Pick<WorkReceiptReversalDeps, "works" | "threadWorks">,
  receipts: WorkReceipt[],
  threadId: ThreadId,
  direction: Direction,
): Promise<boolean> {
  for (const receipt of receipts) {
    const work = await deps.works.findById(receipt.workId);
    switch (receipt.operation) {
      case "create":
        if (direction === "undo" ? !work || !!work.deletedAt : !work?.deletedAt) return false;
        break;
      case "update":
        if (
          !work ||
          work.deletedAt ||
          !sameState(work, direction === "undo" ? receipt.after : receipt.before) ||
          (await nameConflict(
            deps.works,
            work,
            direction === "undo" ? receipt.before : receipt.after,
          ))
        )
          return false;
        break;
      case "delete":
        if (direction === "undo" ? !work?.deletedAt : !work || !!work.deletedAt) return false;
        if (direction === "undo" && work && (await restoreConflict(deps.works, work))) return false;
        break;
      case "switch": {
        const primary = await deps.threadWorks.findPrimary(threadId);
        const expected = direction === "undo" ? receipt.workId : switchTarget(receipt, "undo");
        if (!primary || primary.workId !== expected) return false;
        break;
      }
    }
  }
  return true;
}

async function applyReceipt(
  deps: WorkReceiptReversalDeps,
  thread: NonNullable<Awaited<ReturnType<ThreadRepository["findById"]>>>,
  receipt: WorkReceipt,
  direction: Direction,
  changedProjects: Set<string>,
): Promise<WorkReceiptReversal> {
  const status = direction === "undo" ? "reversed" : "redone";
  const inverse = receipt.inverse;
  if (direction === "undo" && !inverse) {
    return result(receipt, forwardCommand(receipt), "unavailable", "Receipt has no inverse");
  }
  const command = direction === "undo" && inverse ? inverse.command : forwardCommand(receipt);
  const work = await deps.works.findById(receipt.workId);
  if (receipt.operation === "create") {
    if (direction === "undo") {
      if (work?.deletedAt) return result(receipt, command, "already_applied");
      await deps.works.softDelete(receipt.workId);
      const previous =
        receipt.inverse?.command === "delete" ? receipt.inverse.previousCurrentWorkId : null;
      if (previous)
        await deps.preferences.setCurrentWorkId(thread.userId, thread.projectId, previous);
    } else {
      if (!work?.deletedAt) return result(receipt, command, "already_applied");
      await deps.works.restore(receipt.workId);
      await deps.preferences.setCurrentWorkId(thread.userId, thread.projectId, receipt.workId);
    }
  } else if (receipt.operation === "update") {
    const state = direction === "undo" ? receipt.before : receipt.after;
    if (!state) return result(receipt, command, "unavailable", "Receipt state is incomplete");
    if (work && sameState(work, state)) return result(receipt, command, "already_applied");
    await applyState(deps.works, receipt.workId, state);
  } else if (receipt.operation === "delete") {
    if (direction === "undo") {
      if (!work?.deletedAt) return result(receipt, command, "already_applied");
      await deps.works.restore(receipt.workId);
    } else {
      if (work?.deletedAt) return result(receipt, command, "already_applied");
      await deps.works.softDelete(receipt.workId);
    }
  } else {
    const target = direction === "undo" ? switchTarget(receipt, "undo") : receipt.workId;
    const primary = await deps.threadWorks.findPrimary(thread.id);
    if (primary?.workId === target) return result(receipt, command, "already_applied");
    await deps.threadWorks.rebindPrimary(thread.id, target);
    if (thread.kind === "primary") {
      await deps.preferences.setCurrentWorkId(thread.userId, thread.projectId, target);
    }
  }
  changedProjects.add(thread.projectId);
  return result(receipt, command, status);
}

async function applyState(works: WorkRepository, workId: WorkId, state: WorkReceiptState) {
  await works.update(workId, {
    name: state.name,
    goal: state.goal,
    description: state.description,
  });
  if (state.status === "archived") await works.archive(workId);
  else await works.unarchive(workId);
}

function switchTarget(receipt: WorkReceipt, direction: "undo"): WorkId {
  const inverse = receipt.inverse;
  if (direction === "undo" && inverse?.command === "switch") return inverse.workId;
  throw new Error("Switch receipt is missing its inverse");
}

function forwardCommand(receipt: WorkReceipt): WorkReversalResult["command"] {
  switch (receipt.operation) {
    case "create":
      return "restore";
    case "update":
      return "update";
    case "delete":
      return "delete";
    case "switch":
      return "switch";
  }
}

function result(
  receipt: WorkReceipt,
  command: WorkReversalResult["command"],
  status: WorkReversalResult["status"],
  message?: string,
): WorkReceiptReversal {
  return {
    command,
    workId: receipt.workId,
    name: receipt.workName,
    status,
    ...(message ? { message } : {}),
  };
}

function sameState(
  work: { name: string; goal: string | null; description: string | null; status: string },
  state: WorkReceiptState | null,
) {
  return (
    !!state &&
    work.name === state.name &&
    work.goal === state.goal &&
    work.description === state.description &&
    work.status === state.status
  );
}

async function nameConflict(
  works: WorkRepository,
  work: { id: WorkId; projectId: ProjectId },
  target: WorkReceiptState | null,
): Promise<boolean> {
  if (!target) return true;
  const projectWorks = await works.listByProject(work.projectId);
  return projectWorks.some(
    (candidate) =>
      candidate.id !== work.id && candidate.name.toLowerCase() === target.name.toLowerCase(),
  );
}

async function restoreConflict(
  works: WorkRepository,
  work: { id: WorkId; projectId: ProjectId; name: string; slug: string },
): Promise<boolean> {
  const projectWorks = await works.listByProject(work.projectId);
  return projectWorks.some(
    (candidate) =>
      candidate.id !== work.id &&
      (candidate.name.toLowerCase() === work.name.toLowerCase() || candidate.slug === work.slug),
  );
}

function receiptFromContent(content: JsonValue | null): WorkReceipt | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const metadata = content.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  return parseWorkReceipt(metadata.workReceipt);
}
