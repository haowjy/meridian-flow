// Runs write-level undo/redo from durable journal reconstruction.
import * as Y from "yjs";

import { diffSnapshots, snapshotBlocks } from "../apply/echo.js";
import type { AgentEditCodec } from "../codec-adapter.js";
import { toDocHandle } from "../handles.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import type { AgentEditModel } from "../ports/model.js";
import type { ReversalActor, ReversalRecord } from "../ports/types.js";
import { parseWriteHandle, type ReversalStore } from "../ports/update-journal.js";
import { resolveUndoAvailability, type UndoAvailability } from "../undo/availability.js";
import { reconstructUndoUpdateFromSnapshot } from "../undo/reconstruction.js";
import {
  planRedo,
  planUndo,
  type ReversalPlan,
  type ReversalSelection,
} from "../undo/reversal-plan.js";
import type { InternalWriteResult, WriteResultBlock } from "./internal-result.js";
import type { MutationCommit, SyncedMutationSummary } from "./mutation-commit.js";
import { formatConcurrent, status, toOutcome } from "./response-format.js";
import type { RuntimeDocumentState, RuntimeStore } from "./runtime-store.js";
import type { UndoRedoOutcome, WriteCommand, WriteRedoResult, WriteUndoResult } from "./types.js";

export interface UndoNotificationPort {
  record(input: {
    threadId: string;
    writeHandles: string[];
    turnId: string;
    docId: string;
    direction: "undo" | "redo";
  }): Promise<void>;
}

export interface WriteReversal {
  run(input: WriteReversalRunInput): Promise<InternalWriteResult>;
  runWriteReversal(
    input: WriteReversalEndpointInput & { direction: "undo" },
  ): Promise<WriteUndoResult>;
  runWriteReversal(
    input: WriteReversalEndpointInput & { direction: "redo" },
  ): Promise<WriteRedoResult>;
  getAvailability(docId: string, threadId: string): Promise<UndoAvailability>;
}

export interface WriteReversalRunInput {
  docId: string;
  session: ActorSession;
  commandName: WriteCommand["command"];
  direction: "undo" | "redo";
  selection: ReversalSelection;
  actor?: ReversalActor;
}

export interface WriteReversalEndpointInput {
  docId: string;
  session: ActorSession;
  direction: "undo" | "redo";
  selection?: ReversalSelection;
  actor?: ReversalActor;
}

type ReversalResult =
  | {
      ok: true;
      status: UndoRedoOutcome;
      sync?: SyncedMutationSummary;
      targetCount?: number;
      turnId?: string;
    }
  | { ok: false; response: InternalWriteResult };

export function createWriteReversal(deps: {
  reversalStore: ReversalStore;
  runtimeStore: RuntimeStore;
  mutationCommit: MutationCommit;
  model: AgentEditModel;
  codec: AgentEditCodec;
  undoClientId?: number;
  undoNotificationPort?: UndoNotificationPort;
  onInvariantViolation?: (message: string) => void;
}): WriteReversal {
  const {
    reversalStore,
    runtimeStore,
    mutationCommit,
    model,
    codec,
    undoClientId,
    onInvariantViolation = defaultInvariantViolation,
  } = deps;

  return {
    run,
    runWriteReversal,
    getAvailability,
  };

  async function getAvailability(docId: string, threadId: string): Promise<UndoAvailability> {
    const availability = await resolveUndoAvailability({
      reversalStore,
      docId,
      threadId,
    });
    return {
      undo: availability.undo,
      redo: availability.redo,
      ...(availability.undoWriteId ? { undoWriteId: availability.undoWriteId } : {}),
      ...(availability.undoTarget ? { undoTarget: availability.undoTarget } : {}),
      ...(availability.redoWriteId ? { redoWriteId: availability.redoWriteId } : {}),
    };
  }

  async function run(input: WriteReversalRunInput): Promise<InternalWriteResult> {
    const runtime = runtimeStore.runtimeFor(input.session, input.docId);
    const synced = await runtimeStore.requireSynced(
      input.session,
      input.docId,
      input.docId,
      runtime,
    );
    if (!synced.ok) return synced.response;
    return runUndoOrRedo({ ...input, runtime });
  }

  function runWriteReversal(
    input: WriteReversalEndpointInput & { direction: "undo" },
  ): Promise<WriteUndoResult>;
  function runWriteReversal(
    input: WriteReversalEndpointInput & { direction: "redo" },
  ): Promise<WriteRedoResult>;
  async function runWriteReversal(
    input: WriteReversalEndpointInput,
  ): Promise<WriteUndoResult | WriteRedoResult> {
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
          selection: input.selection ?? { kind: "latest" },
          actor: input.actor ?? { type: "agent" },
        });
    if (result.status !== "document_not_found") {
      invalidateRuntimeThread(input.docId, input.session.threadId);
    }
    return toOutcome(input.direction, result) as WriteUndoResult | WriteRedoResult;
  }

  async function runUndoOrRedo(input: {
    docId: string;
    session: ActorSession;
    runtime: RuntimeDocumentState;
    commandName: WriteCommand["command"];
    direction: "undo" | "redo";
    selection: ReversalSelection;
    actor?: ReversalActor;
  }): Promise<InternalWriteResult> {
    const actor = input.actor ?? { type: "agent" as const };
    const first = await reverseOne({ ...input, actor });
    if (!first.ok) return first.response;
    if (first.status === "nothing_to_undo" || first.status === "nothing_to_redo")
      return status(first.status);
    if (first.status === "expired") return status("expired");

    let reversal = first;
    let targetCount = first.targetCount ?? 0;
    const selection = resolvedScopeSelection(input.selection, first);
    // Turn/thread redo can span several undo groups. Replay each eligible group
    // in redo order so a scope redo never reports success while leaving part of
    // that same scope reversed. Each iteration reloads planning state after the
    // prior redo has been persisted, which keeps reconstruction snapshot-safe.
    if (isScopeSelection(selection)) {
      while (true) {
        const next = await reverseOne({ ...input, selection, actor });
        if (!next.ok) return next.response;
        if (next.status === "nothing_to_redo" || next.status === "nothing_to_undo") break;
        if (next.status === "expired") return status("expired");
        reversal = next;
        targetCount += next.targetCount ?? 0;
      }
    }

    if (reversal.sync) runtimeStore.markSynced(input.session, input.docId, input.runtime);
    const outcome = reversal.status;
    const metaLines = [`status: ${outcome}`];
    if (targetCount > 0) metaLines.push(`${input.direction}: ${targetCount} edit(s)`);
    if (reversal.sync?.concurrentEdits)
      metaLines.push(...formatConcurrent(reversal.sync.concurrentEdits));

    const echoLines =
      reversal.sync?.echo.flatMap((hunk) => hunk.blocks).filter((line) => line.length > 0) ?? [];
    const content: WriteResultBlock[] = [{ type: "text", text: metaLines.join("\n") }];
    if (echoLines.length > 0) content.push({ type: "text", text: echoLines.join("\n") });
    return {
      status: outcome,
      text: content.map((block) => block.text).join("\n\n"),
      content,
    };
  }

  function resolvedScopeSelection(
    selection: ReversalSelection,
    first: Extract<ReversalResult, { ok: true }>,
  ): ReversalSelection {
    if (selection.kind !== "turn" || selection.turnId !== undefined || first.turnId === undefined) {
      return selection;
    }
    return { kind: "turn", turnId: first.turnId };
  }

  function isScopeSelection(selection: ReversalSelection): boolean {
    return selection.kind === "turn" || selection.kind === "all";
  }

  async function reverseOne(input: {
    docId: string;
    session: ActorSession;
    runtime: RuntimeDocumentState;
    commandName: WriteCommand["command"];
    direction: "undo" | "redo";
    selection: ReversalSelection;
    actor: ReversalActor;
  }): Promise<ReversalResult> {
    const threadId = input.session.threadId;
    const plan = await (input.direction === "undo"
      ? planUndo({ reversalStore, docId: input.docId, threadId, selection: input.selection })
      : planRedo({ reversalStore, docId: input.docId, threadId, selection: input.selection }));
    if (!plan.ok) {
      if (plan.status === "cant_undo_dependent") {
        return {
          ok: false,
          response: status(
            plan.status,
            plan.message ??
              formatDependentUndoRefusal(
                plan.selectedWriteIds ?? [],
                plan.blockingWriteIds ?? ["a later edit"],
              ),
          ),
        };
      }
      if (plan.status === "invalid_write")
        return { ok: false, response: status("invalid_write", plan.message) };
      return { ok: true, status: plan.status };
    }

    const before = snapshotBlocks(toDocHandle(input.runtime.doc), model, codec);

    let reconstructed: { ok: true; update: Uint8Array } | { ok: false };
    try {
      if (input.direction === "undo") {
        const cold = reconstructUndoUpdateFromSnapshot(plan.snapshot, {
          docId: input.docId,
          targetId: formatWriteSelection(plan.writeIds),
          targetSeqs: plan.targetSeqs,
          undoClientId,
        });
        reconstructed = { ok: true, update: cold.undoUpdate };
      } else {
        const undoUpdateSeq = plan.redoGroup?.undoUpdateSeq;
        if (undoUpdateSeq === undefined) return { ok: true, status: "nothing_to_redo" };
        const cold = reconstructUndoUpdateFromSnapshot(plan.snapshot, {
          docId: input.docId,
          targetId: `redo ${formatWriteSelection(plan.writeIds)}`,
          targetSeqs: new Set([undoUpdateSeq]),
          undoClientId,
        });
        reconstructed = { ok: true, update: cold.undoUpdate };
      }
    } catch (cause) {
      return surfaceColdReversalInvariant({
        direction: input.direction,
        writeIds: plan.writeIds,
        detail: {
          docId: input.docId,
          threadId,
          turnId: plan.turnId,
          undoUpdateSeq: plan.redoGroup?.undoUpdateSeq,
        },
        cause,
      });
    }
    if (!reconstructed.ok)
      return {
        ok: true,
        status: input.direction === "undo" ? "nothing_to_undo" : "nothing_to_redo",
      };

    const persisted = await persistPlan({
      docId: input.docId,
      threadId,
      plan,
      direction: input.direction,
      update: reconstructed.update,
      actor: input.actor,
    });
    if (!persisted.ok)
      return {
        ok: true,
        status: input.direction === "undo" ? "nothing_to_undo" : "nothing_to_redo",
      };

    Y.applyUpdate(input.runtime.doc, reconstructed.update, { type: "system" });
    const afterOwnVector = Y.encodeStateVector(input.runtime.doc);
    const ownDiff = diffSnapshots(
      before,
      snapshotBlocks(toDocHandle(input.runtime.doc), model, codec),
    );

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
    });
    if (!sync.ok) return { ok: false, response: sync.response };
    return {
      ok: true,
      status: sync.summary.reconciled ? "reconciled" : "reversed",
      sync: sync.summary,
      targetCount: plan.writeIds.length,
      turnId: plan.turnId,
    };
  }

  function surfaceColdReversalInvariant(input: {
    direction: "undo" | "redo";
    writeIds: readonly string[];
    detail: { docId: string; threadId: string; turnId: string; undoUpdateSeq?: number };
    cause: unknown;
  }): ReversalResult {
    const safeWrite = input.writeIds.length === 1 ? ` for ${input.writeIds[0]}` : "";
    const detail = [
      `Cold ${input.direction} reconstruction invariant failed for document ${input.detail.docId}, thread ${input.detail.threadId}, write(s) ${input.writeIds.join(", ")}`,
      input.detail.undoUpdateSeq === undefined
        ? undefined
        : `undo update seq ${input.detail.undoUpdateSeq}`,
      `turn ${input.detail.turnId}`,
      formatCause(input.cause),
    ]
      .filter(Boolean)
      .join(": ");
    onInvariantViolation(detail);
    return {
      ok: false,
      response: status("internal_error", `Retry — transient edit system failure${safeWrite}.`),
    };
  }

  async function persistPlan(input: {
    docId: string;
    threadId: string;
    direction: "undo" | "redo";
    plan: Extract<ReversalPlan, { ok: true }>;
    update: Uint8Array;
    actor: ReversalActor;
  }): Promise<{ ok: true } | { ok: false }> {
    if (input.direction === "undo") {
      const record: ReversalRecord = {
        documentId: input.docId,
        turnId: input.plan.turnId,
        threadId: input.threadId,
        writeIds: input.plan.writeIds,
        status: "reversed",
        undoUpdateSeq: 0,
        reversedAt: new Date(),
        ...(input.actor.type === "user" ? { reversedByUserId: input.actor.userId } : {}),
      };
      await reversalStore.persistUndo(input.docId, input.update, [record], input.actor);
      if (input.actor.type === "user") {
        await recordUndoNotification({
          threadId: input.threadId,
          writeHandles: [...input.plan.writeIds],
          turnId: input.plan.turnId,
          docId: input.docId,
          direction: input.direction,
        });
      }
      return { ok: true };
    }
    const undoUpdateSeq = input.plan.redoGroup?.undoUpdateSeq;
    if (undoUpdateSeq === undefined) return { ok: false };
    const consumed = await reversalStore.persistRedo(
      input.docId,
      input.update,
      { threadId: input.threadId, undoUpdateSeq },
      { origin: "system", seq: 0 },
    );
    if (!consumed.consumed) return { ok: false };
    if (input.actor.type === "user") {
      await recordUndoNotification({
        threadId: input.threadId,
        writeHandles: [...input.plan.writeIds],
        turnId: input.plan.turnId,
        docId: input.docId,
        direction: input.direction,
      });
    }
    return { ok: true };
  }

  async function recordUndoNotification(input: Parameters<UndoNotificationPort["record"]>[0]) {
    try {
      await deps.undoNotificationPort?.record(input);
    } catch (cause) {
      console.error("agent-edit undo notification recording failed", {
        threadId: input.threadId,
        docId: input.docId,
        turnId: input.turnId,
        direction: input.direction,
        writeHandleCount: input.writeHandles.length,
        cause: formatCause(cause),
      });
    }
  }

  function invalidateRuntimeThread(docId: string, threadId: string): void {
    runtimeStore.evictThreadRuntimes(docId, threadId, { needsRecovery: true });
  }
}

function formatDependentUndoRefusal(
  selectedWriteIds: readonly string[],
  blockingWriteIds: readonly string[],
): string {
  const selected = formatWriteSelection(selectedWriteIds);
  const blockers = formatWriteList(blockingWriteIds);
  const pronoun = selectedWriteIds.length === 1 ? "it" : "that range";
  const remedyRange = dependentUndoRemedyRange(selectedWriteIds, blockingWriteIds);
  const remedy = remedyRange
    ? `Undo ${blockers} first, or undo the range ${remedyRange}.`
    : `Undo ${blockers} first, or undo the dependent range together.`;
  return `Can't undo ${selected} on its own — ${blockers} was built on ${pronoun}. ${remedy}`;
}

function dependentUndoRemedyRange(
  selectedWriteIds: readonly string[],
  blockingWriteIds: readonly string[],
): string | undefined {
  const ordinals = [...selectedWriteIds, ...blockingWriteIds]
    .map((handle) => (isWriteHandle(handle) ? parseWriteHandle(handle) : undefined))
    .filter((ordinal): ordinal is number => ordinal !== undefined);
  if (ordinals.length !== selectedWriteIds.length + blockingWriteIds.length) return undefined;
  const min = Math.min(...ordinals);
  const max = Math.max(...ordinals);
  return min === max ? `w${min}` : `w${min}..w${max}`;
}

function formatWriteSelection(writeIds: readonly string[]): string {
  if (writeIds.length === 0) return "that edit";
  if (writeIds.length === 1) return writeIds[0] ?? "that edit";
  const ordinals = writeIds.map((handle) => parseWriteHandle(handle));
  const allOrdinals = ordinals.every((ordinal): ordinal is number => ordinal !== undefined);
  if (allOrdinals) {
    const sorted = [...ordinals].sort((left, right) => left - right);
    const contiguous = sorted.every(
      (ordinal, index) => index === 0 || ordinal === sorted[index - 1] + 1,
    );
    if (contiguous) return `w${sorted[0]}..w${sorted.at(-1)}`;
  }
  return formatWriteList(writeIds);
}

function formatWriteList(writeIds: readonly string[]): string {
  if (writeIds.length <= 1) return writeIds[0] ?? "a later edit";
  if (writeIds.length === 2) return `${writeIds[0]} and ${writeIds[1]}`;
  return `${writeIds.slice(0, -1).join(", ")}, and ${writeIds.at(-1)}`;
}

function isWriteHandle(handle: string): boolean {
  return parseWriteHandle(handle) !== undefined;
}

function formatCause(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : String(cause);
}

function defaultInvariantViolation(message: string): never {
  throw new Error(message);
}
