// Runs turn-level undo/redo from durable journal reconstruction.
import * as Y from "yjs";

import { diffSnapshots, snapshotBlocks } from "../apply/echo.js";
import type { ApplyEchoHunk, ConcurrentEditInfo } from "../apply/types.js";
import type { Codec } from "../codec/types.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import type { AgentEditModel } from "../ports/model.js";
import type { ReversalRecord } from "../ports/types.js";
import type { TurnMutationRow, UpdateJournal } from "../ports/update-journal.js";
import {
  latestRedoableTarget,
  latestUndoableTurn,
  resolveUndoAvailability,
  type UndoAvailability,
} from "../undo/availability.js";
import { reconstructRedoUpdate, reconstructUndoUpdate } from "../undo/reconstruction.js";
import type { InternalWriteResult } from "./internal-result.js";
import type { MutationCommit, SyncedMutationSummary } from "./mutation-commit.js";
import type { RuntimeDocumentState, RuntimeStore } from "./runtime-store.js";
import type {
  TurnRedoResult,
  TurnUndoResult,
  UndoRedoOutcome,
  WriteCommand,
  WriteErrorStatus,
  WriteOutcome,
  WriteStatus,
} from "./types.js";

export interface TurnReversal {
  run(input: TurnReversalRunInput): Promise<InternalWriteResult>;
  runTurnReversal(
    input: TurnReversalEndpointInput & { direction: "undo" },
  ): Promise<TurnUndoResult>;
  runTurnReversal(
    input: TurnReversalEndpointInput & { direction: "redo" },
  ): Promise<TurnRedoResult>;
  getAvailability(docId: string, threadId: string): Promise<UndoAvailability>;
}

export interface TurnReversalRunInput {
  docId: string;
  session: ActorSession;
  commandName: WriteCommand["command"];
  direction: "undo" | "redo";
  count: { all: boolean; count: number };
}

export interface TurnReversalEndpointInput {
  docId: string;
  session: ActorSession;
  direction: "undo" | "redo";
}

type ReversalResult =
  | {
      ok: true;
      status: UndoRedoOutcome;
      sync?: SyncedMutationSummary;
    }
  | { ok: false; response: InternalWriteResult };

export function createTurnReversal(deps: {
  journal: UpdateJournal;
  runtimeStore: RuntimeStore;
  mutationCommit: MutationCommit;
  model: AgentEditModel;
  codec: Codec;
  retention?: {
    reversalWindowMs?: number;
  };
  undoClientId?: number;
  onInvariantViolation?: (message: string) => void;
}): TurnReversal {
  const {
    journal,
    runtimeStore,
    mutationCommit,
    model,
    codec,
    retention,
    undoClientId,
    onInvariantViolation = defaultInvariantViolation,
  } = deps;

  return {
    run,
    runTurnReversal,
    getAvailability,
  };

  async function getAvailability(docId: string, threadId: string): Promise<UndoAvailability> {
    const availability = await resolveUndoAvailability({
      journal,
      mutationQueries: journal,
      docId,
      threadId,
    });
    return {
      undo: availability.undo,
      redo: availability.redo,
      ...(availability.undoTurnId ? { undoTurnId: availability.undoTurnId } : {}),
      ...(availability.redoTurnId ? { redoTurnId: availability.redoTurnId } : {}),
    };
  }

  async function run(input: TurnReversalRunInput): Promise<InternalWriteResult> {
    const runtime = runtimeStore.runtimeFor(input.session, input.docId);
    const synced = runtimeStore.requireSynced(input.session, input.docId);
    if (!synced.ok) return synced.response;
    return runUndoOrRedo({ ...input, runtime });
  }

  function runTurnReversal(
    input: TurnReversalEndpointInput & { direction: "undo" },
  ): Promise<TurnUndoResult>;
  function runTurnReversal(
    input: TurnReversalEndpointInput & { direction: "redo" },
  ): Promise<TurnRedoResult>;
  async function runTurnReversal(
    input: TurnReversalEndpointInput,
  ): Promise<TurnUndoResult | TurnRedoResult> {
    invalidateRuntimeThread(input.docId, input.session.threadId);
    const runtime = runtimeStore.runtimeFor(input.session, input.docId);
    const synced = await runtimeStore.syncLocalFromLive(
      input.session,
      input.docId,
      runtime,
      input.direction,
    );
    const result = !synced.ok
      ? synced.response
      : await runUndoOrRedo({
          docId: input.docId,
          session: input.session,
          runtime,
          commandName: input.direction,
          direction: input.direction,
          count: { all: false, count: 1 },
        });
    if (result.status !== "document_not_found") {
      invalidateRuntimeThread(input.docId, input.session.threadId);
    }
    return toOutcome(input.direction, result) as TurnUndoResult | TurnRedoResult;
  }

  async function runUndoOrRedo(input: {
    docId: string;
    session: ActorSession;
    runtime: RuntimeDocumentState;
    commandName: WriteCommand["command"];
    direction: "undo" | "redo";
    count: { all: boolean; count: number };
  }): Promise<InternalWriteResult> {
    let applied = 0;
    let lastOutcome: UndoRedoOutcome | null = null;
    const echo: ApplyEchoHunk[] = [];
    const concurrentEdits: ConcurrentEditInfo[] = [];
    let sawReconcile = false;
    const limit = input.count.all ? Number.POSITIVE_INFINITY : input.count.count;

    while (applied < limit) {
      const result =
        input.direction === "undo"
          ? await undoOne(input.docId, input.session, input.runtime, input.commandName)
          : await redoOne(input.docId, input.session, input.runtime, input.commandName);
      if (!result.ok) return result.response;
      if (result.status === "nothing_to_undo" || result.status === "nothing_to_redo") {
        if (applied === 0) return status(result.status);
        lastOutcome = input.count.all ? (sawReconcile ? "reconciled" : "reversed") : "partial";
        break;
      }
      if (result.status === "expired") {
        if (applied === 0) return status("expired");
        lastOutcome = "partial";
        break;
      }
      if (result.status !== "reversed" && result.status !== "reconciled") {
        lastOutcome = result.status;
        break;
      }
      if (result.status === "reconciled") sawReconcile = true;
      if (result.sync) {
        echo.push(...result.sync.echo);
        if (result.sync.concurrentEdits) concurrentEdits.push(result.sync.concurrentEdits);
      }
      applied += 1;
      runtimeStore.markSynced(input.session, input.docId, input.runtime);
    }

    const outcome = lastOutcome ?? (sawReconcile ? "reconciled" : "reversed");
    const lines = [`status: ${outcome}`];
    if (applied > 0) lines.push("", `${input.direction}: ${applied} edit(s)`);
    const echoLines = echo.flatMap((hunk) => hunk.blocks).filter((line) => line.length > 0);
    if (echoLines.length > 0) lines.push("", ...echoLines);
    for (const concurrent of concurrentEdits) lines.push("", ...formatConcurrent(concurrent));
    return result(outcome, lines.join("\n"));
  }

  async function undoOne(
    docId: string,
    session: ActorSession,
    runtime: RuntimeDocumentState,
    commandName: WriteCommand["command"],
  ): Promise<ReversalResult> {
    const availableTurnId = await latestUndoableTurn({
      journal,
      mutationQueries: journal,
      docId,
      threadId: session.threadId,
    });
    if (!availableTurnId) return { ok: true, status: "nothing_to_undo" };

    const before = snapshotBlocks(runtime.doc, model, codec);
    let targetSeqs: ReadonlySet<number>;
    try {
      targetSeqs = await targetSeqsForUndo(journal, docId, session.threadId, availableTurnId);
    } catch (cause) {
      return surfaceColdReversalInvariant({
        direction: "undo",
        docId,
        threadId: session.threadId,
        turnId: availableTurnId,
        cause,
      });
    }
    if (targetSeqs.size === 0) return { ok: true, status: "nothing_to_undo" };

    let update: Uint8Array;
    try {
      const cold = await reconstructUndoUpdate(journal, docId, availableTurnId, {
        targetSeqs,
        undoClientId,
      });
      update = cold.undoUpdate;
      Y.applyUpdate(runtime.doc, update, { type: "system" });
    } catch (cause) {
      return surfaceColdReversalInvariant({
        direction: "undo",
        docId,
        threadId: session.threadId,
        turnId: availableTurnId,
        cause,
      });
    }

    const turnId = availableTurnId;
    const afterOwnVector = Y.encodeStateVector(runtime.doc);
    const ownDiff = diffSnapshots(before, snapshotBlocks(runtime.doc, model, codec));

    const record: ReversalRecord = {
      documentId: docId,
      turnId,
      threadId: session.threadId,
      status: "reversed",
      undoUpdateSeq: 0,
      reversedAt: new Date(),
      ...(retention?.reversalWindowMs
        ? { expiresAt: new Date(Date.now() + retention.reversalWindowMs) }
        : {}),
    };
    await journal.persistReversal(docId, update, record);
    const sync = await mutationCommit.syncAfterLocalMutation({
      docId,
      commandName,
      runtime,
      update,
      afterOwnVector,
      liveOrigin: { type: "system" },
      before,
      touchedHashes: new Set([...ownDiff.changed, ...ownDiff.inserted]),
      deletedHashes: ownDiff.deleted,
      structuralChange: ownDiff.deleted.size > 0 || ownDiff.inserted.size > 0,
    });
    if (!sync.ok) return { ok: false, response: sync.response };
    popIfTop(runtime.undoStack, turnId);
    runtime.redoStack.push({ turnId, undoUpdateSeq: record.undoUpdateSeq || undefined });
    return {
      ok: true,
      status: sync.summary.reconciled ? "reconciled" : "reversed",
      sync: sync.summary,
    };
  }

  async function redoOne(
    docId: string,
    session: ActorSession,
    runtime: RuntimeDocumentState,
    commandName: WriteCommand["command"],
  ): Promise<ReversalResult> {
    const redoTarget = await latestRedoableTarget({
      journal,
      mutationQueries: journal,
      docId,
      threadId: session.threadId,
    });
    if (!redoTarget) return { ok: true, status: "nothing_to_redo" };

    const before = snapshotBlocks(runtime.doc, model, codec);
    let targetSeqs: ReadonlySet<number>;
    try {
      targetSeqs = await targetSeqsForRedo(
        journal,
        docId,
        session.threadId,
        redoTarget.turnId,
        redoTarget.undoUpdateSeq,
      );
    } catch (cause) {
      return surfaceColdReversalInvariant({
        direction: "redo",
        docId,
        threadId: session.threadId,
        turnId: redoTarget.turnId,
        undoUpdateSeq: redoTarget.undoUpdateSeq,
        cause,
      });
    }
    if (targetSeqs.size === 0) {
      popIfTop(runtime.redoStack, redoTarget.turnId);
      return { ok: true, status: "nothing_to_redo" };
    }

    let cold: Awaited<ReturnType<typeof reconstructRedoUpdate>>;
    try {
      cold = await reconstructRedoUpdate(
        journal,
        docId,
        redoTarget.turnId,
        redoTarget.undoUpdateSeq,
        { targetSeqs, undoClientId },
      );
    } catch (cause) {
      return surfaceColdReversalInvariant({
        direction: "redo",
        docId,
        threadId: session.threadId,
        turnId: redoTarget.turnId,
        undoUpdateSeq: redoTarget.undoUpdateSeq,
        cause,
      });
    }
    if (!cold.ok) {
      popIfTop(runtime.redoStack, redoTarget.turnId);
      return { ok: true, status: "nothing_to_redo" };
    }
    const update = cold.redoUpdate;

    const consumed = await journal.persistRedo(
      docId,
      update,
      {
        threadId: session.threadId,
        turnId: redoTarget.turnId,
        undoUpdateSeq: redoTarget.undoUpdateSeq,
      },
      { origin: "system", seq: 0 },
    );
    if (!consumed.consumed) {
      popIfTop(runtime.redoStack, redoTarget.turnId);
      return { ok: true, status: "nothing_to_redo" };
    }

    const turnId = redoTarget.turnId;
    Y.applyUpdate(runtime.doc, update, { type: "system" });
    const afterOwnVector = Y.encodeStateVector(runtime.doc);
    const ownDiff = diffSnapshots(before, snapshotBlocks(runtime.doc, model, codec));

    const sync = await mutationCommit.syncAfterLocalMutation({
      docId,
      commandName,
      runtime,
      update,
      afterOwnVector,
      liveOrigin: { type: "system" },
      before,
      touchedHashes: new Set([...ownDiff.changed, ...ownDiff.inserted]),
      deletedHashes: ownDiff.deleted,
      structuralChange: ownDiff.deleted.size > 0 || ownDiff.inserted.size > 0,
    });
    if (!sync.ok) return { ok: false, response: sync.response };
    popIfTop(runtime.redoStack, turnId);
    runtime.undoStack.push(turnId);
    return {
      ok: true,
      status: sync.summary.reconciled ? "reconciled" : "reversed",
      sync: sync.summary,
    };
  }

  function surfaceColdReversalInvariant(input: {
    direction: "undo" | "redo";
    docId: string;
    threadId: string;
    turnId: string;
    undoUpdateSeq?: number;
    cause: unknown;
  }): ReversalResult {
    const message = [
      `Cold ${input.direction} reconstruction invariant failed for document ${input.docId}, thread ${input.threadId}, turn ${input.turnId}`,
      input.undoUpdateSeq === undefined ? undefined : `undo update seq ${input.undoUpdateSeq}`,
      formatCause(input.cause),
    ]
      .filter(Boolean)
      .join(": ");
    onInvariantViolation(message);
    return {
      ok: false,
      response: status("internal_error", `Retry — transient edit system failure. ${message}`),
    };
  }

  function invalidateRuntimeThread(docId: string, threadId: string): void {
    runtimeStore.evictThreadRuntimes(docId, threadId, { needsRecovery: true });
  }
}

async function targetSeqsForUndo(
  journal: UpdateJournal,
  docId: string,
  threadId: string,
  turnId: string,
): Promise<ReadonlySet<number>> {
  return mutationSeqs(
    (await journal.mutationsForTurn(docId, threadId, turnId)).filter(
      (row) => row.status === "active",
    ),
  );
}

async function targetSeqsForRedo(
  journal: UpdateJournal,
  docId: string,
  threadId: string,
  turnId: string,
  undoUpdateSeq: number,
): Promise<ReadonlySet<number>> {
  return mutationSeqs(
    (await journal.mutationsForTurn(docId, threadId, turnId)).filter(
      (row) => row.status === "reversed" && row.undoUpdateSeq === undoUpdateSeq,
    ),
  );
}

function mutationSeqs(rows: readonly TurnMutationRow[]): ReadonlySet<number> {
  return new Set(rows.map((row) => row.createdSeq));
}

function status(code: WriteStatus, message?: string): InternalWriteResult {
  return result(code, message ? `status: ${code}\n\n${message}` : `status: ${code}`);
}

function result(status: WriteStatus, text: string): InternalWriteResult {
  return { status, text };
}

function toOutcome(command: "undo" | "redo", result: InternalWriteResult): WriteOutcome {
  return {
    command,
    status: result.status,
    isError: isWriteErrorStatus(result.status),
    text: result.text,
  };
}

function isWriteErrorStatus(status: WriteStatus): status is WriteErrorStatus {
  return (
    status === "not_found" ||
    status === "ambiguous_match" ||
    status === "invalid_write" ||
    status === "document_not_found" ||
    status === "partial_failure" ||
    status === "internal_error"
  );
}

function formatConcurrent(info: ConcurrentEditInfo): string[] {
  const lines = ["concurrent edits:"];
  if (info.human.length > 0) lines.push(`  human: ${info.human.join(", ")}`);
  if (info.agent.length > 0) lines.push(`  agent: ${info.agent.join(", ")}`);
  if (info.reviewCommand) lines.push(info.reviewCommand);
  return lines;
}

function popIfTop(stack: string[], value: string): void;
function popIfTop(stack: Array<{ turnId: string; undoUpdateSeq?: number }>, value: string): void;
function popIfTop(
  stack: string[] | Array<{ turnId: string; undoUpdateSeq?: number }>,
  value: string,
): void {
  const last = stack.at(-1);
  if (typeof last === "string") {
    while (stack.at(-1) === value) stack.pop();
    return;
  }
  let item = stack.at(-1);
  while (item && typeof item !== "string" && item.turnId === value) {
    stack.pop();
    item = stack.at(-1);
  }
}

function formatCause(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : String(cause);
}

function defaultInvariantViolation(message: string): never {
  throw new Error(message);
}
