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

interface ReversalTarget {
  turnId: string;
  undoUpdateSeq?: number;
}

interface ReversalDirection {
  direction: "undo" | "redo";
  emptyStatus: "nothing_to_undo" | "nothing_to_redo";
  findTarget(input: ReversalTargetInput): Promise<ReversalTarget | null>;
  targetSeqs(input: ReversalTargetSeqInput): Promise<ReadonlySet<number>>;
  reconstruct(
    input: ReversalReconstructInput,
  ): Promise<{ ok: true; update: Uint8Array } | { ok: false }>;
  persist(input: ReversalPersistInput): Promise<{ ok: true } | { ok: false }>;
}

interface ReversalTargetInput {
  docId: string;
  threadId: string;
}

interface ReversalTargetSeqInput extends ReversalTargetInput {
  target: ReversalTarget;
}

interface ReversalReconstructInput {
  docId: string;
  target: ReversalTarget;
  targetSeqs: ReadonlySet<number>;
}

interface ReversalPersistInput extends ReversalTargetInput {
  target: ReversalTarget;
  update: Uint8Array;
}

export function createTurnReversal(deps: {
  journal: UpdateJournal;
  runtimeStore: RuntimeStore;
  mutationCommit: MutationCommit;
  model: AgentEditModel;
  codec: Codec;
  undoClientId?: number;
  onInvariantViolation?: (message: string) => void;
}): TurnReversal {
  const {
    journal,
    runtimeStore,
    mutationCommit,
    model,
    codec,
    undoClientId,
    onInvariantViolation = defaultInvariantViolation,
  } = deps;

  const directions: Record<"undo" | "redo", ReversalDirection> = {
    undo: {
      direction: "undo",
      emptyStatus: "nothing_to_undo",
      async findTarget(input) {
        const turnId = await latestUndoableTurn({
          journal,
          mutationQueries: journal,
          docId: input.docId,
          threadId: input.threadId,
        });
        return turnId ? { turnId } : null;
      },
      targetSeqs: (input) =>
        targetSeqsForUndo(journal, input.docId, input.threadId, input.target.turnId),
      async reconstruct(input) {
        const cold = await reconstructUndoUpdate(journal, input.docId, input.target.turnId, {
          targetSeqs: input.targetSeqs,
          undoClientId,
        });
        return { ok: true, update: cold.undoUpdate };
      },
      async persist(input) {
        const record: ReversalRecord = {
          documentId: input.docId,
          turnId: input.target.turnId,
          threadId: input.threadId,
          status: "reversed",
          undoUpdateSeq: 0,
          reversedAt: new Date(),
        };
        await journal.persistReversal(input.docId, input.update, record);
        return { ok: true };
      },
    },
    redo: {
      direction: "redo",
      emptyStatus: "nothing_to_redo",
      async findTarget(input) {
        return (
          (await latestRedoableTarget({
            journal,
            mutationQueries: journal,
            docId: input.docId,
            threadId: input.threadId,
          })) ?? null
        );
      },
      targetSeqs: (input) =>
        targetSeqsForRedo(
          journal,
          input.docId,
          input.threadId,
          input.target.turnId,
          requireUndoUpdateSeq(input.target),
        ),
      async reconstruct(input) {
        const cold = await reconstructRedoUpdate(
          journal,
          input.docId,
          input.target.turnId,
          requireUndoUpdateSeq(input.target),
          { targetSeqs: input.targetSeqs, undoClientId },
        );
        return cold.ok ? { ok: true, update: cold.redoUpdate } : { ok: false };
      },
      async persist(input) {
        const consumed = await journal.persistRedo(
          input.docId,
          input.update,
          {
            threadId: input.threadId,
            turnId: input.target.turnId,
            undoUpdateSeq: requireUndoUpdateSeq(input.target),
          },
          { origin: "system", seq: 0 },
        );
        return consumed.consumed ? { ok: true } : { ok: false };
      },
    },
  };

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
      const result = await reverseOne({
        docId: input.docId,
        session: input.session,
        runtime: input.runtime,
        commandName: input.commandName,
        direction: directions[input.direction],
      });
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

  async function reverseOne(input: {
    docId: string;
    session: ActorSession;
    runtime: RuntimeDocumentState;
    commandName: WriteCommand["command"];
    direction: ReversalDirection;
  }): Promise<ReversalResult> {
    const threadId = input.session.threadId;
    const target = await input.direction.findTarget({ docId: input.docId, threadId });
    if (!target) return { ok: true, status: input.direction.emptyStatus };

    const before = snapshotBlocks(input.runtime.doc, model, codec);
    let targetSeqs: ReadonlySet<number>;
    try {
      targetSeqs = await input.direction.targetSeqs({ docId: input.docId, threadId, target });
    } catch (cause) {
      return surfaceColdReversalInvariant({
        direction: input.direction.direction,
        docId: input.docId,
        threadId,
        turnId: target.turnId,
        undoUpdateSeq: target.undoUpdateSeq,
        cause,
      });
    }
    if (targetSeqs.size === 0) return { ok: true, status: input.direction.emptyStatus };

    let reconstructed: { ok: true; update: Uint8Array } | { ok: false };
    try {
      reconstructed = await input.direction.reconstruct({
        docId: input.docId,
        target,
        targetSeqs,
      });
    } catch (cause) {
      return surfaceColdReversalInvariant({
        direction: input.direction.direction,
        docId: input.docId,
        threadId,
        turnId: target.turnId,
        undoUpdateSeq: target.undoUpdateSeq,
        cause,
      });
    }
    if (!reconstructed.ok) return { ok: true, status: input.direction.emptyStatus };

    const persisted = await input.direction.persist({
      docId: input.docId,
      threadId,
      target,
      update: reconstructed.update,
    });
    if (!persisted.ok) return { ok: true, status: input.direction.emptyStatus };

    Y.applyUpdate(input.runtime.doc, reconstructed.update, { type: "system" });
    const afterOwnVector = Y.encodeStateVector(input.runtime.doc);
    const ownDiff = diffSnapshots(before, snapshotBlocks(input.runtime.doc, model, codec));

    const sync = await mutationCommit.syncAfterLocalMutation({
      docId: input.docId,
      commandName: input.commandName,
      runtime: input.runtime,
      update: reconstructed.update,
      afterOwnVector,
      liveOrigin: { type: "system" },
      before,
      touchedHashes: new Set([...ownDiff.changed, ...ownDiff.inserted]),
      deletedHashes: ownDiff.deleted,
      structuralChange: ownDiff.deleted.size > 0 || ownDiff.inserted.size > 0,
    });
    if (!sync.ok) return { ok: false, response: sync.response };
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

function requireUndoUpdateSeq(target: ReversalTarget): number {
  if (target.undoUpdateSeq === undefined) {
    throw new Error(`Missing undo update seq for redo turn ${target.turnId}`);
  }
  return target.undoUpdateSeq;
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

function formatCause(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : String(cause);
}

function defaultInvariantViolation(message: string): never {
  throw new Error(message);
}
