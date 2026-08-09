/** Plans and executes typed durable Work receipts through one ordered state machine. */
import type { ReversalOutcome, WorkReversalResult } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { JsonValue, Thread } from "@meridian/contracts/threads";
import {
  parseWorkReceipt,
  type Work,
  type WorkReceipt,
  type WorkReceiptState,
} from "@meridian/contracts/works";
import type { NoticePort } from "../domains/notices/index.js";
import type { ProjectPreferencesRepository } from "../domains/preferences/index.js";
import type { WorkContextDelivery, WorkRepository } from "../domains/projects/index.js";
import type {
  BlockRepository,
  ThreadRepository,
  ThreadWorksRepository,
  TurnRepository,
  WorkContextDeliveryRepository,
} from "../domains/threads/index.js";
import { rebindThreadWork } from "../domains/threads/index.js";
import { recordWriterWorkSwitchNotice } from "./writer-work-switch-notice.js";

type WorkReceiptReversalDeps = {
  blocks: Pick<BlockRepository, "listByTurn">;
  turns: Pick<TurnRepository, "findById">;
  threads: Pick<ThreadRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary" | "lockPrimary" | "rebindPrimary">;
  preferences: Pick<ProjectPreferencesRepository, "setCurrentWorkId">;
  works: WorkRepository;
  workContextDelivery: Pick<WorkContextDelivery, "projectChanged" | "deliverAfterCommit">;
  obligations: Pick<WorkContextDeliveryRepository, "enqueueThread">;
  notices: Pick<NoticePort, "record">;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
};

export type WorkReceiptReversal = WorkReversalResult & { workId: WorkId };
type Direction = "undo" | "redo";
type ShadowWork = Work & { deleted: boolean };
type PlannedStep = {
  receipt: WorkReceipt;
  command: WorkReversalResult["command"];
  executable: boolean;
  message?: string;
};

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
  const context = await reversalContext(deps, input);
  if (!context) return [];
  const ordered = orderReceipts(context.receipts, input.direction);
  const changedProjects = new Set<string>();
  let threadContextChanged = false;
  try {
    const results = await deps.transaction(async () => {
      await lockReceiptState(deps, ordered, context.thread);
      const plan = await planReceipts(deps, ordered, context.thread, input.direction, true);
      const applied: WorkReceiptReversal[] = [];
      for (const step of plan) {
        if (!step.executable) {
          applied.push(result(step.receipt, step.command, "unavailable", step.message));
          continue;
        }
        const changedThreadContext = await applyStep(
          deps,
          context.thread,
          step.receipt,
          input.direction,
        );
        if (changedThreadContext) threadContextChanged = true;
        else if (step.receipt.operation !== "switch") changedProjects.add(context.thread.projectId);
        applied.push(
          result(step.receipt, step.command, input.direction === "undo" ? "reversed" : "redone"),
        );
      }
      await Promise.all(
        [...changedProjects].map((projectId) => deps.workContextDelivery.projectChanged(projectId)),
      );
      return applied;
    });
    if (threadContextChanged) {
      await deps.workContextDelivery.deliverAfterCommit(input.threadId);
    }
    return results;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return ordered.map((receipt) =>
      result(receipt, commandFor(receipt, input.direction), "failed", message),
    );
  }
}

export async function getWorkReceiptReversalAvailability(
  deps: Pick<WorkReceiptReversalDeps, "blocks" | "turns" | "works" | "threads" | "threadWorks">,
  input: { threadId: ThreadId; turnId: TurnId },
): Promise<{ undo: boolean; redo: boolean }> {
  const context = await reversalContext(deps, input);
  if (!context || context.receipts.length === 0) return { undo: false, redo: false };
  const [undo, redo] = await Promise.all(
    (["undo", "redo"] as const).map(async (direction) => {
      const plan = await planReceipts(
        deps,
        orderReceipts(context.receipts, direction),
        context.thread,
        direction,
        false,
      );
      return plan.length > 0 && plan.every((step) => step.executable);
    }),
  );
  return { undo, redo };
}

async function reversalContext(
  deps: Pick<WorkReceiptReversalDeps, "blocks" | "turns" | "threads">,
  input: { threadId: ThreadId; turnId: TurnId },
): Promise<{ thread: Thread; receipts: WorkReceipt[] } | null> {
  const [turn, thread] = await Promise.all([
    deps.turns.findById(input.turnId),
    deps.threads.findById(input.threadId),
  ]);
  if (!turn || turn.threadId !== input.threadId || !thread) return null;
  return { thread, receipts: await receiptsForTurn(deps, input.turnId) };
}

function orderReceipts(receipts: WorkReceipt[], direction: Direction): WorkReceipt[] {
  return direction === "undo" ? [...receipts].reverse() : receipts;
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

async function lockReceiptState(
  deps: Pick<WorkReceiptReversalDeps, "works" | "threadWorks">,
  receipts: WorkReceipt[],
  thread: Thread,
): Promise<void> {
  const ids = new Set<WorkId>();
  for (const receipt of receipts) {
    ids.add(receipt.workId);
    if (receipt.inverse?.command === "switch") ids.add(receipt.inverse.workId);
  }
  for (const workId of [...ids].sort()) await deps.works.lockById(workId);
  await deps.threadWorks.lockPrimary(thread.id);
}

async function planReceipts(
  deps: Pick<WorkReceiptReversalDeps, "works" | "threadWorks">,
  receipts: WorkReceipt[],
  thread: Thread,
  direction: Direction,
  locked: boolean,
): Promise<PlannedStep[]> {
  const [projectWorks, primary] = await Promise.all([
    deps.works.listByProject(thread.projectId, { includeDeleted: true }),
    locked ? deps.threadWorks.lockPrimary(thread.id) : deps.threadWorks.findPrimary(thread.id),
  ]);
  const works = new Map<WorkId, ShadowWork>(
    projectWorks.map((work) => [work.id, { ...work, deleted: !!work.deletedAt }]),
  );
  let primaryWorkId = primary?.workId ?? null;
  const plan: PlannedStep[] = [];

  for (const receipt of receipts) {
    const command = commandFor(receipt, direction);
    const unavailable = (message: string) => {
      plan.push({ receipt, command, executable: false, message });
    };
    const work = works.get(receipt.workId);

    if (direction === "undo" && !receipt.inverse) {
      unavailable("Receipt has no inverse");
      continue;
    }

    if (receipt.operation === "update") {
      const expected = direction === "undo" ? receipt.after : receipt.before;
      const target = direction === "undo" ? receipt.before : receipt.after;
      if (!work || work.deleted || !sameState(work, expected) || !target) {
        unavailable("Work state diverged from the receipt");
        continue;
      }
      if (hasNameConflict(works, work.id, target.name)) {
        unavailable("Work name is no longer available");
        continue;
      }
      Object.assign(work, target);
    } else if (receipt.operation === "create") {
      if (!work || !sameState(work, receipt.after)) {
        unavailable("Created Work state diverged from the receipt");
        continue;
      }
      const expectsDeleted = direction === "redo";
      if (work.deleted !== expectsDeleted) {
        unavailable("Created Work lifecycle diverged from the receipt");
        continue;
      }
      if (direction === "redo" && hasIdentityConflict(works, work)) {
        unavailable("Created Work identity is no longer available");
        continue;
      }
      work.deleted = direction === "undo";
    } else if (receipt.operation === "delete") {
      if (!work || !sameState(work, receipt.before)) {
        unavailable("Deleted Work state diverged from the receipt");
        continue;
      }
      const expectsDeleted = direction === "undo";
      if (work.deleted !== expectsDeleted) {
        unavailable("Deleted Work lifecycle diverged from the receipt");
        continue;
      }
      if (direction === "undo" && hasIdentityConflict(works, work)) {
        unavailable("Deleted Work identity is no longer available");
        continue;
      }
      work.deleted = direction === "redo";
    } else {
      const from = direction === "undo" ? receipt.workId : switchTarget(receipt);
      const to = direction === "undo" ? switchTarget(receipt) : receipt.workId;
      if (primaryWorkId !== from || works.get(to)?.deleted !== false) {
        unavailable("Conversation Work diverged from the receipt");
        continue;
      }
      primaryWorkId = to;
    }
    plan.push({ receipt, command, executable: true });
  }
  return plan;
}

async function applyStep(
  deps: WorkReceiptReversalDeps,
  thread: Thread,
  receipt: WorkReceipt,
  direction: Direction,
): Promise<boolean> {
  if (receipt.operation === "create") {
    if (direction === "undo") {
      await deps.works.softDelete(receipt.workId);
      const previous =
        receipt.inverse?.command === "delete" ? receipt.inverse.previousCurrentWorkId : null;
      if (previous) {
        await deps.preferences.setCurrentWorkId(thread.userId, thread.projectId, previous);
      }
    } else {
      await deps.works.restore(receipt.workId);
      await deps.preferences.setCurrentWorkId(thread.userId, thread.projectId, receipt.workId);
    }
  } else if (receipt.operation === "update") {
    const state = direction === "undo" ? receipt.before : receipt.after;
    if (!state) throw new Error("Receipt state is incomplete");
    await applyState(deps.works, receipt.workId, state);
  } else if (receipt.operation === "delete") {
    if (direction === "undo") await deps.works.restore(receipt.workId);
    else await deps.works.softDelete(receipt.workId);
  } else {
    const target = direction === "undo" ? switchTarget(receipt) : receipt.workId;
    const rebound = await rebindThreadWork(deps, {
      threadId: thread.id,
      targetWorkId: target,
      preferenceUserId: thread.userId,
    });
    await recordWriterWorkSwitchNotice(deps.notices, rebound);
    return rebound.changed;
  }
  return false;
}

async function applyState(works: WorkRepository, workId: WorkId, state: WorkReceiptState) {
  await works.update(workId, {
    name: state.name,
    goal: state.goal,
    description: state.description,
    status: state.status,
  });
}

function switchTarget(receipt: WorkReceipt): WorkId {
  if (receipt.inverse?.command === "switch") return receipt.inverse.workId;
  throw new Error("Switch receipt is missing its inverse");
}

function commandFor(receipt: WorkReceipt, direction: Direction): WorkReversalResult["command"] {
  if (direction === "undo" && receipt.inverse) return receipt.inverse.command;
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
  work: Pick<Work, "name" | "goal" | "description" | "status">,
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

function hasNameConflict(works: Map<WorkId, ShadowWork>, workId: WorkId, name: string) {
  return [...works.values()].some(
    (candidate) =>
      candidate.id !== workId &&
      !candidate.deleted &&
      candidate.name.toLowerCase() === name.toLowerCase(),
  );
}

function hasIdentityConflict(works: Map<WorkId, ShadowWork>, work: ShadowWork) {
  return [...works.values()].some(
    (candidate) =>
      candidate.id !== work.id &&
      !candidate.deleted &&
      (candidate.name.toLowerCase() === work.name.toLowerCase() || candidate.slug === work.slug),
  );
}

function receiptFromContent(content: JsonValue | null): WorkReceipt | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const metadata = content.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  return parseWorkReceipt(metadata.workReceipt);
}
