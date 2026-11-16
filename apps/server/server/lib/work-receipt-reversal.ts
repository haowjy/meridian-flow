/** Decides each durable Work receipt's fate, undoes the ones that act, and composes the reply's chip. */

import type { CommandId, UserId } from "@meridian/contracts";
import type {
  ReversalOutcome,
  TurnReceiptChip,
  WorkReversalResult,
} from "@meridian/contracts/protocol";
import type { ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { JsonValue, Thread } from "@meridian/contracts/threads";
import {
  isReversibleWorkReceipt,
  isWorkArchived,
  parseWorkReceipt,
  type Work,
  type WorkReceipt,
  type WorkReceiptInverse,
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
type ReversibleWorkReceipt = WorkReceipt & { inverse: WorkReceiptInverse };
/**
 * What one Work receipt's Undo comes to: `acts` still has to run, `taken` already stands as
 * its inverse leaves it (the writer did it, or an earlier Undo), and `stayed` can't run.
 */
type WorkFate = "acts" | "taken" | "stayed";
type PlannedStep = {
  receipt: ReversibleWorkReceipt;
  command: WorkReversalResult["command"];
  fate: WorkFate;
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
  // The Work half is its own part: each receipt's fate decides it, whatever the documents did.
  const alongsideRun = async (outcome: ReversalOutcome): Promise<ReversalOutcome> =>
    combineWorkReversalOutcome(
      outcome,
      await reverseWorkReceipts(
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
      ),
    );
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

/**
 * The click's answer with its Work part: a Work taken back counts as reversed, one that stayed
 * is a part the Undo left, and only a Work step that threw is a failure.
 */
export function combineWorkReversalOutcome(
  outcome: ReversalOutcome,
  workReceipts: WorkReceiptReversal[],
): ReversalOutcome {
  if (workReceipts.length === 0) return outcome;
  const reversed = workReceipts.filter((result) => result.status === "reversed").length;
  const stayed = workReceipts.some((result) => result.status === "unavailable");
  const documentsDidNothing = outcome.status === "nothing_to_undo" || outcome.status === "expired";
  const status = workReceipts.some((result) => result.status === "failed")
    ? "partial_failure"
    : !stayed
      ? documentsDidNothing
        ? "reversed"
        : outcome.status === "not_undone"
          ? "partial"
          : outcome.status
      : documentsDidNothing || outcome.status === "not_undone"
        ? reversed
          ? "partial"
          : documentsDidNothing
            ? "expired"
            : "not_undone"
        : outcome.status === "reversed" || outcome.status === "reconciled"
          ? "partial"
          : outcome.status;
  return {
    ...outcome,
    status,
    acceptedParts: (outcome.acceptedParts ?? 0) + reversed,
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
        if (step.fate === "acts") await applyStep(deps, step.receipt);
        applied.push(
          result(
            step.receipt,
            context.thread.projectId,
            step.command,
            step.fate === "stayed" ? "unavailable" : "reversed",
            step.message,
          ),
        );
      }
      return applied;
    });
  } catch (error) {
    // A deadlock or serialization failure is the server's to retry, never the click's answer.
    if (isRetryableTransactionError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return ordered.map((receipt) =>
      result(receipt, context.thread.projectId, receipt.inverse.command, "failed", message),
    );
  }
}

/**
 * The reply's chip, composed once from its parts: the documents' and tree's (`chip`) and its
 * Work receipts'. Undo while any part acts; Undone when every part is taken back.
 */
export async function getTurnReceiptChip(
  deps: Pick<WorkReceiptReversalDeps, "blocks" | "turns" | "works" | "threads"> & {
    documentSync: Pick<AppServices["documentSync"], "getTurnReceiptChip">;
  },
  input: { threadId: ThreadId; turnId: TurnId },
): Promise<TurnReceiptChip | null> {
  const [chip, context] = await Promise.all([
    deps.documentSync.getTurnReceiptChip(input.threadId, input.turnId),
    reversalContext(deps, input),
  ]);
  if (!context?.receipts.length) return chip;
  const fates = (await planReceipts(deps, [...context.receipts].reverse(), context.thread)).map(
    ({ fate }) => fate,
  );
  if (chip?.control === "undo" || fates.includes("acts"))
    return { ...chip, state: "live-active", control: "undo" };
  const taken = fates.includes("taken") || (!!chip && chip.state !== "expired");
  const stayed = fates.includes("stayed") || (!!chip && chip.state !== "undone");
  return {
    ...chip,
    state: taken ? (stayed ? "partly" : "undone") : "expired",
    control: "view_change",
  };
}

async function reversalContext(
  deps: Pick<WorkReceiptReversalDeps, "blocks" | "turns" | "threads">,
  input: { threadId: ThreadId; turnId: TurnId },
): Promise<{ thread: Thread; receipts: ReversibleWorkReceipt[] } | null> {
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
): Promise<ReversibleWorkReceipt[]> {
  return (await deps.blocks.listByTurn(turnId)).flatMap((block) => {
    const receipt = receiptFromContent(block.content);
    return receipt && isReversibleWorkReceipt(receipt) ? [receipt as ReversibleWorkReceipt] : [];
  });
}

async function lockReceiptState(
  deps: Pick<WorkReceiptReversalDeps, "works">,
  receipts: WorkReceipt[],
): Promise<void> {
  const ids = new Set<WorkId>(receipts.map(({ workId }) => workId));
  for (const workId of [...ids].sort()) await deps.works.lockById(workId);
}

/**
 * Each receipt's step, in undo order. A Work's receipts share one fate, decided by where the
 * turn started and ended it: at its start the Undo is taken, at its end it acts, anywhere else
 * it stayed. A turn that set a Work back as it found it is taken, so its Undo never loops.
 */
async function planReceipts(
  deps: Pick<WorkReceiptReversalDeps, "works">,
  receipts: ReversibleWorkReceipt[],
  thread: Thread,
): Promise<PlannedStep[]> {
  const projectWorks = await deps.works.listByProject(thread.projectId, {
    includeDeleted: true,
    lifecycle: "all",
  });
  const works = new Map<WorkId, ShadowWork>(
    projectWorks.map((work) => [work.id, { ...work, deleted: !!work.deletedAt }]),
  );
  const fates = new Map<WorkId, { fate: WorkFate; message?: string }>();
  for (const receipt of receipts) {
    if (fates.has(receipt.workId)) continue;
    const turn = receipts.filter(({ workId }) => workId === receipt.workId);
    const first = turn.at(-1) ?? receipt;
    const work = works.get(receipt.workId);
    fates.set(receipt.workId, workFate(works, work, first, receipt));
    // A Work this Undo restores or deletes frees or takes its handle for the Works after it.
    if (work && fates.get(receipt.workId)?.fate === "acts")
      work.deleted = first.operation === "create";
  }
  return receipts.map((receipt) => ({
    receipt,
    command: receipt.inverse.command,
    ...(fates.get(receipt.workId) ?? { fate: "stayed" }),
  }));
}

/** One Work's fate, from the turn's first and last receipt for it. */
function workFate(
  works: Map<WorkId, ShadowWork>,
  work: ShadowWork | undefined,
  first: ReversibleWorkReceipt,
  last: ReversibleWorkReceipt,
): { fate: WorkFate; message?: string } {
  const startedDeleted = first.operation === "create";
  const endedDeleted = last.operation === "delete";
  // A Work the turn deleted that stands again is taken back, whatever it is called now.
  const taken = startedDeleted
    ? !work || work.deleted
    : !!work && !work.deleted && (first.operation === "delete" || sameState(work, first.before));
  if (taken) return { fate: "taken" };
  if (
    !work ||
    work.deleted !== endedDeleted ||
    !sameState(work, endedDeleted ? last.before : last.after)
  )
    return { fate: "stayed", message: "Work state diverged from the receipt" };
  if (endedDeleted && !startedDeleted && hasIdentityConflict(works, work))
    return { fate: "stayed", message: "Deleted Work identity is no longer available" };
  return { fate: "acts" };
}

async function applyStep(
  deps: Pick<WorkReceiptReversalDeps, "works" | "workContextNotices" | "stopThreads">,
  receipt: ReversibleWorkReceipt,
): Promise<void> {
  if (receipt.operation === "create") {
    // The tree's runs and subagent lineages end in this transaction, before its rows lock.
    await deps.works.softDelete(receipt.workId, deps.stopThreads);
  } else if (receipt.operation === "update") {
    if (!receipt.before) throw new Error("Receipt state is incomplete");
    await applyState(deps, receipt.workId, receipt.before);
  } else {
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
