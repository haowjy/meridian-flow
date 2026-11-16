/** Plans and executes typed durable Work receipts through one ordered state machine. */

import type { CommandId, UserId } from "@meridian/contracts";
import type { ReversalOutcome, WorkReversalResult } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { JsonValue, Thread } from "@meridian/contracts/threads";
import {
  isReversibleWorkReceipt,
  isWorkArchived,
  parseWorkReceipt,
  type Work,
  type WorkReceipt,
  type WorkReceiptState,
} from "@meridian/contracts/works";
import {
  runWorkLifecycleCommand,
  setWorkArchived,
  updateWorkTransition,
  type WorkContextNotices,
  type WorkRepository,
} from "../domains/projects/index.js";
import type {
  BlockRepository,
  ThreadRepository,
  TurnRepository,
} from "../domains/threads/index.js";
import {
  isRetryableTransactionError,
  runInDrizzleSavepoint,
} from "../shared/drizzle-transaction.js";
import type { AppServices } from "./compose.js";
import { getDb } from "./db.js";

type WorkReceiptReversalDeps = {
  blocks: Pick<BlockRepository, "listByTurn">;
  turns: Pick<TurnRepository, "findById">;
  threads: Pick<ThreadRepository, "findById">;
  works: WorkRepository;
  workContextNotices: Pick<WorkContextNotices, "workChanged">;
  stopThreads: (threadIds: readonly ThreadId[]) => Promise<void>;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
};

export type WorkReceiptReversal = WorkReversalResult & { workId: WorkId };
type ShadowWork = Work & { deleted: boolean };
type PlannedStep = {
  receipt: WorkReceipt;
  command: WorkReversalResult["command"];
  executable: boolean;
  message?: string;
};

/**
 * A chat card's Undo: the turn's documents, then its Work receipts, in one command.
 * The Works the receipts name are read first (a turn's blocks never change), so the command
 * locks them with the documents' before any document lock.
 */
export async function reverseTurnCard(
  app: Pick<
    AppServices,
    | "documentSync"
    | "threadRepos"
    | "works"
    | "stopThreads"
    | "contextPorts"
    | "fileAccess"
    | "workAuthorityResolver"
  > & { workContextNotices: Pick<WorkContextNotices, "workChanged"> },
  input: {
    threadId: ThreadId;
    turnId: TurnId;
    userId: UserId;
    commandId: CommandId;
  },
): Promise<ReversalOutcome> {
  const receiptWorkIds = await workReceiptWorkIds(
    {
      blocks: app.threadRepos.blocks,
      turns: app.threadRepos.turns,
      threads: app.threadRepos.threads,
    },
    input,
  );
  const alongsideRun = async (outcome: ReversalOutcome): Promise<ReversalOutcome> => {
    const canReverseWorkReceipts =
      outcome.status === "reversed" ||
      outcome.status === "reconciled" ||
      outcome.status === "nothing_to_undo" ||
      outcome.status === "partial" ||
      outcome.status === "partial_failure";
    if (!canReverseWorkReceipts) return outcome;
    const workReceipts = await reverseWorkReceipts(
      {
        blocks: app.threadRepos.blocks,
        turns: app.threadRepos.turns,
        threads: app.threadRepos.threads,
        works: app.works,
        workContextNotices: app.workContextNotices,
        stopThreads: app.stopThreads,
        // A step's savepoint: a Work that fails leaves the others and the stored answer.
        transaction: (operation) => runInDrizzleSavepoint(getDb(), operation),
      },
      input,
    );
    return combineWorkReversalOutcome(outcome, workReceipts);
  };
  return app.documentSync.reverseThreadContext({
    ...input,
    alongside: {
      workIds: receiptWorkIds,
      lockNamespaces: () => app.works.lockRestoreNamespaces(receiptWorkIds),
      run: alongsideRun,
    },
  });
}

async function workReceiptWorkIds(
  deps: Pick<WorkReceiptReversalDeps, "blocks" | "turns" | "threads">,
  input: { threadId: ThreadId; turnId: TurnId },
): Promise<WorkId[]> {
  const context = await reversalContext(deps, input);
  return context ? [...new Set(context.receipts.map(({ workId }) => workId))] : [];
}

export function combineWorkReversalOutcome(
  outcome: ReversalOutcome,
  workReceipts: WorkReceiptReversal[],
): ReversalOutcome {
  if (workReceipts.length === 0) return outcome;
  const succeeded = workReceipts.some((result) => result.status === "reversed");
  const failed = workReceipts.some(
    (result) => result.status === "failed" || result.status === "unavailable",
  );
  return {
    ...outcome,
    status: failed
      ? "partial_failure"
      : succeeded && outcome.status === "nothing_to_undo"
        ? "reversed"
        : outcome.status,
    workReceipts,
  };
}

export async function reverseWorkReceipts(
  deps: WorkReceiptReversalDeps,
  input: { threadId: ThreadId; turnId: TurnId },
): Promise<WorkReceiptReversal[]> {
  const context = await reversalContext(deps, input);
  if (!context) return [];
  const ordered = [...context.receipts].reverse();
  try {
    return await runWorkLifecycleCommand(deps.transaction, async () => {
      await lockReceiptState(deps, ordered);
      const plan = await planReceipts(deps, ordered, context.thread);
      const applied: WorkReceiptReversal[] = [];
      for (const step of plan) {
        if (!step.executable) {
          applied.push(
            result(
              step.receipt,
              context.thread.projectId,
              step.command,
              "unavailable",
              step.message,
            ),
          );
          continue;
        }
        await applyStep(deps, step.receipt);
        applied.push(result(step.receipt, context.thread.projectId, step.command, "reversed"));
      }
      return applied;
    });
  } catch (error) {
    // A deadlock or serialization failure is the server's to retry, never the click's answer.
    if (isRetryableTransactionError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return ordered.map((receipt) =>
      result(receipt, context.thread.projectId, commandFor(receipt), "failed", message),
    );
  }
}

export async function getWorkReceiptReversalAvailability(
  deps: Pick<WorkReceiptReversalDeps, "blocks" | "turns" | "works" | "threads">,
  input: { threadId: ThreadId; turnId: TurnId },
): Promise<{ undo: boolean }> {
  const context = await reversalContext(deps, input);
  if (!context || context.receipts.length === 0) return { undo: false };
  const plan = await planReceipts(deps, [...context.receipts].reverse(), context.thread);
  return { undo: plan.length > 0 && plan.every((step) => step.executable) };
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

async function receiptsForTurn(
  deps: Pick<WorkReceiptReversalDeps, "blocks">,
  turnId: TurnId,
): Promise<WorkReceipt[]> {
  return (await deps.blocks.listByTurn(turnId)).flatMap((block) => {
    const receipt = receiptFromContent(block.content);
    return receipt && isReversibleWorkReceipt(receipt) ? [receipt] : [];
  });
}

async function lockReceiptState(
  deps: Pick<WorkReceiptReversalDeps, "works">,
  receipts: WorkReceipt[],
): Promise<void> {
  const ids = new Set<WorkId>(receipts.map(({ workId }) => workId));
  for (const workId of [...ids].sort()) await deps.works.lockById(workId);
}

async function planReceipts(
  deps: Pick<WorkReceiptReversalDeps, "works">,
  receipts: WorkReceipt[],
  thread: Thread,
): Promise<PlannedStep[]> {
  const projectWorks = await deps.works.listByProject(thread.projectId, {
    includeDeleted: true,
    lifecycle: "all",
  });
  const works = new Map<WorkId, ShadowWork>(
    projectWorks.map((work) => [work.id, { ...work, deleted: !!work.deletedAt }]),
  );
  const plan: PlannedStep[] = [];

  for (const receipt of receipts) {
    const command = commandFor(receipt);
    const unavailable = (message: string) => {
      plan.push({ receipt, command, executable: false, message });
    };
    const work = works.get(receipt.workId);

    if (!receipt.inverse) {
      unavailable("Receipt has no inverse");
      continue;
    }

    if (receipt.operation === "update") {
      const expected = receipt.after;
      const target = receipt.before;
      if (!work || work.deleted || !sameState(work, expected) || !target) {
        unavailable("Work state diverged from the receipt");
        continue;
      }
      Object.assign(work, target);
    } else if (receipt.operation === "create") {
      if (!work || !sameState(work, receipt.after)) {
        unavailable("Created Work state diverged from the receipt");
        continue;
      }
      if (work.deleted) {
        unavailable("Created Work lifecycle diverged from the receipt");
        continue;
      }
      work.deleted = true;
    } else if (receipt.operation === "delete") {
      if (!work || !sameState(work, receipt.before)) {
        unavailable("Deleted Work state diverged from the receipt");
        continue;
      }
      if (!work.deleted) {
        unavailable("Deleted Work lifecycle diverged from the receipt");
        continue;
      }
      if (hasIdentityConflict(works, work)) {
        unavailable("Deleted Work identity is no longer available");
        continue;
      }
      work.deleted = false;
    }
    plan.push({ receipt, command, executable: true });
  }
  return plan;
}

async function applyStep(
  deps: Pick<WorkReceiptReversalDeps, "works" | "workContextNotices" | "stopThreads">,
  receipt: WorkReceipt,
): Promise<void> {
  if (receipt.operation === "create") {
    await deps.works.softDelete(receipt.workId, deps.stopThreads);
  } else if (receipt.operation === "update") {
    if (!receipt.before) throw new Error("Receipt state is incomplete");
    await applyState(deps, receipt.workId, receipt.before);
  } else if (receipt.operation === "delete") {
    await deps.works.restore(receipt.workId);
    await deps.workContextNotices.workChanged(receipt.workId);
  }
}

async function applyState(
  deps: Pick<WorkReceiptReversalDeps, "works" | "workContextNotices">,
  workId: WorkId,
  state: WorkReceiptState,
) {
  let current = await deps.works.findById(workId);
  if (!current) throw new Error(`Work not found: ${workId}`);
  if (!state.archived && isWorkArchived(current)) {
    current = (
      await setWorkArchived(
        { works: deps.works, workContextNotices: deps.workContextNotices },
        workId,
        false,
      )
    ).after;
  }
  if (
    current.name !== state.name ||
    current.goal !== state.goal ||
    current.status !== state.status
  ) {
    current = (
      await updateWorkTransition(
        { works: deps.works, workContextNotices: deps.workContextNotices },
        workId,
        { name: state.name, goal: state.goal, status: state.status },
      )
    ).after;
  }
  if (state.archived && !isWorkArchived(current)) {
    await setWorkArchived(
      { works: deps.works, workContextNotices: deps.workContextNotices },
      workId,
      true,
    );
  }
}

function commandFor(receipt: WorkReceipt): WorkReversalResult["command"] {
  if (receipt.inverse) return receipt.inverse.command;
  switch (receipt.operation) {
    case "create":
      return "delete";
    case "update":
      return "update";
    case "delete":
      return "restore";
  }
}

function result(
  receipt: WorkReceipt,
  projectId: string,
  command: WorkReversalResult["command"],
  status: WorkReversalResult["status"],
  message?: string,
): WorkReceiptReversal {
  return {
    command,
    projectId,
    workId: receipt.workId,
    name: receipt.workName,
    status,
    ...(message ? { message } : {}),
  };
}

function sameState(
  work: Pick<Work, "name" | "goal" | "status" | "archivedAt">,
  state: WorkReceiptState | null,
) {
  return (
    !!state &&
    work.name === state.name &&
    work.goal === state.goal &&
    work.status === state.status &&
    isWorkArchived(work) === state.archived
  );
}

function hasIdentityConflict(works: Map<WorkId, ShadowWork>, work: ShadowWork) {
  return [...works.values()].some(
    (candidate) =>
      candidate.id !== work.id && !candidate.deleted && candidate.handle === work.handle,
  );
}

function receiptFromContent(content: JsonValue | null): WorkReceipt | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const metadata = content.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  return parseWorkReceipt(metadata.workReceipt);
}
