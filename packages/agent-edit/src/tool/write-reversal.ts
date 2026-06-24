// Runs write-level undo/redo from durable journal reconstruction.
import * as Y from "yjs";

import { diffSnapshots, snapshotBlocks } from "../apply/echo.js";
import type { Codec } from "../codec/types.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import type { AgentEditModel } from "../ports/model.js";
import type { PersistedUpdate, ReversalRecord } from "../ports/types.js";
import {
  parseWriteHandle,
  type UpdateJournal,
  type WriteMutationRow,
} from "../ports/update-journal.js";
import {
  latestRedoableTarget,
  latestUndoableWrite,
  redoableTargets,
  resolveUndoAvailability,
  specificRedoableTarget,
  specificUndoableWrite,
  type UndoAvailability,
  undoableWrites,
} from "../undo/availability.js";
import { reconstructRedoUpdate, reconstructUndoUpdate } from "../undo/reconstruction.js";
import type { InternalWriteResult } from "./internal-result.js";
import type { MutationCommit, SyncedMutationSummary } from "./mutation-commit.js";
import { formatConcurrent, result, status, toOutcome } from "./response-format.js";
import type { RuntimeDocumentState, RuntimeStore } from "./runtime-store.js";
import type { UndoRedoOutcome, WriteCommand, WriteRedoResult, WriteUndoResult } from "./types.js";

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
}

export interface WriteReversalEndpointInput {
  docId: string;
  session: ActorSession;
  direction: "undo" | "redo";
}

type ReversalResult =
  | {
      ok: true;
      status: UndoRedoOutcome;
      sync?: SyncedMutationSummary;
      targetCount?: number;
    }
  | { ok: false; response: InternalWriteResult };

type ReversalSelection =
  | { kind: "latest" }
  | { kind: "single"; to: string }
  | { kind: "range"; from: string; to: string }
  | { kind: "last"; count: number }
  | { kind: "all" };

interface ReversalTarget {
  writeId: string;
  turnId: string;
  writeIds: string[];
  undoUpdateSeq?: number;
}

interface ReversalDirection {
  direction: "undo" | "redo";
  emptyStatus: "nothing_to_undo" | "nothing_to_redo";
  findTarget(input: ReversalTargetInput): Promise<ReversalTarget | null>;
  targetSeqs(input: ReversalTargetSeqInput): Promise<ReadonlySet<number>>;
  guard?(input: ReversalGuardInput): Promise<DependentUndoGuardResult>;
  reconstruct(
    input: ReversalReconstructInput,
  ): Promise<{ ok: true; update: Uint8Array } | { ok: false }>;
  persist(input: ReversalPersistInput): Promise<{ ok: true } | { ok: false }>;
}

interface ReversalTargetInput {
  docId: string;
  threadId: string;
  selection: ReversalSelection;
}

interface ReversalTargetSeqInput {
  docId: string;
  threadId: string;
  target: ReversalTarget;
}

interface ReversalReconstructInput {
  docId: string;
  target: ReversalTarget;
  targetSeqs: ReadonlySet<number>;
}

interface ReversalGuardInput {
  docId: string;
  threadId: string;
  target: ReversalTarget;
  targetSeqs: ReadonlySet<number>;
}

interface ReversalPersistInput {
  docId: string;
  threadId: string;
  target: ReversalTarget;
  update: Uint8Array;
}

export function createWriteReversal(deps: {
  journal: UpdateJournal;
  runtimeStore: RuntimeStore;
  mutationCommit: MutationCommit;
  model: AgentEditModel;
  codec: Codec;
  undoClientId?: number;
  onInvariantViolation?: (message: string) => void;
}): WriteReversal {
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
        const targets = await selectUndoTargets(input.selection, {
          journal,
          docId: input.docId,
          threadId: input.threadId,
        });
        return targets.length > 0 ? combineTargets(targets) : null;
      },
      targetSeqs: (input) =>
        targetSeqsForUndo(journal, input.docId, input.threadId, input.target.writeId),
      guard: (input) => guardDependentUndo(journal, input),
      async reconstruct(input) {
        const cold = await reconstructUndoUpdate(journal, input.docId, input.target.writeId, {
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
          writeId: input.target.writeId,
          writeIds: input.target.writeIds,
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
        const targets = await selectRedoTargets(input.selection, {
          journal,
          docId: input.docId,
          threadId: input.threadId,
        });
        return targets.length > 0 ? combineTargets(targets) : null;
      },
      targetSeqs: (input) =>
        targetSeqsForRedo(
          journal,
          input.docId,
          input.threadId,
          input.target.writeId,
          requireUndoUpdateSeq(input.target),
        ),
      async reconstruct(input) {
        const cold = await reconstructRedoUpdate(
          journal,
          input.docId,
          input.target.writeId,
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
            writeId: input.target.writeId,
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
    runWriteReversal,
    getAvailability,
  };

  async function getAvailability(docId: string, threadId: string): Promise<UndoAvailability> {
    const availability = await resolveUndoAvailability({
      journal,
      mutationQueries: requiredMutationQueries(journal),
      docId,
      threadId,
    });
    return {
      undo: availability.undo,
      redo: availability.redo,
      ...(availability.undoWriteId ? { undoWriteId: availability.undoWriteId } : {}),
      ...(availability.redoWriteId ? { redoWriteId: availability.redoWriteId } : {}),
    };
  }

  async function run(input: WriteReversalRunInput): Promise<InternalWriteResult> {
    const runtime = runtimeStore.runtimeFor(input.session, input.docId);
    const synced = runtimeStore.requireSynced(input.session, input.docId);
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
          selection: { kind: "latest" },
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
  }): Promise<InternalWriteResult> {
    const reversal = await reverseOne({
      docId: input.docId,
      session: input.session,
      runtime: input.runtime,
      commandName: input.commandName,
      direction: directions[input.direction],
      selection: input.selection,
    });
    if (!reversal.ok) return reversal.response;
    if (reversal.status === "nothing_to_undo" || reversal.status === "nothing_to_redo")
      return status(reversal.status);
    if (reversal.status === "expired") return status("expired");

    if (reversal.sync) runtimeStore.markSynced(input.session, input.docId, input.runtime);
    const outcome = reversal.status;
    const lines = [`status: ${outcome}`];
    const count = reversal.targetCount ?? 0;
    if (count > 0) lines.push("", `${input.direction}: ${count} edit(s)`);
    const echoLines =
      reversal.sync?.echo.flatMap((hunk) => hunk.blocks).filter((line) => line.length > 0) ?? [];
    if (echoLines.length > 0) lines.push("", ...echoLines);
    if (reversal.sync?.concurrentEdits)
      lines.push("", ...formatConcurrent(reversal.sync.concurrentEdits));
    return result(outcome, lines.join("\n"));
  }

  async function reverseOne(input: {
    docId: string;
    session: ActorSession;
    runtime: RuntimeDocumentState;
    commandName: WriteCommand["command"];
    direction: ReversalDirection;
    selection: ReversalSelection;
  }): Promise<ReversalResult> {
    const threadId = input.session.threadId;
    const target = await input.direction.findTarget({
      docId: input.docId,
      threadId,
      selection: input.selection,
    });
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
        writeId: target.writeId,
        turnId: target.turnId,
        undoUpdateSeq: target.undoUpdateSeq,
        cause,
      });
    }
    if (targetSeqs.size === 0) return { ok: true, status: input.direction.emptyStatus };

    const guard = await input.direction.guard?.({
      docId: input.docId,
      threadId,
      target,
      targetSeqs,
    });
    if (guard && !guard.ok) {
      return {
        ok: false,
        response: status(
          "cant_undo_dependent",
          formatDependentUndoRefusal(target.writeIds, guard.blockingWriteIds),
        ),
      };
    }

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
        writeId: target.writeId,
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
      targetCount: target.writeIds.length,
    };
  }

  function surfaceColdReversalInvariant(input: {
    direction: "undo" | "redo";
    docId: string;
    threadId: string;
    writeId: string;
    turnId: string;
    undoUpdateSeq?: number;
    cause: unknown;
  }): ReversalResult {
    const message = [
      `Cold ${input.direction} reconstruction invariant failed for document ${input.docId}, thread ${input.threadId}, write ${input.writeId}`,
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

function requiredMutationQueries(journal: UpdateJournal) {
  if (
    !journal.latestActiveWrite ||
    !journal.activeWriteSummary ||
    !journal.writeMinCreatedSeq ||
    !journal.mutationsForWrite
  ) {
    throw new Error("UpdateJournal write-level mutation queries are required");
  }
  return journal as Required<
    Pick<
      UpdateJournal,
      "latestActiveWrite" | "activeWriteSummary" | "writeMinCreatedSeq" | "mutationsForWrite"
    >
  >;
}

function requireUndoUpdateSeq(target: ReversalTarget): number {
  if (target.undoUpdateSeq === undefined) {
    throw new Error(`Missing undo update seq for redo write ${target.writeId}`);
  }
  return target.undoUpdateSeq;
}

async function targetSeqsForUndo(
  journal: UpdateJournal,
  docId: string,
  threadId: string,
  writeId: string,
): Promise<ReadonlySet<number>> {
  return mutationSeqs(
    (
      await Promise.all(
        writeId
          .split(",")
          .map((id) => requiredMutationQueries(journal).mutationsForWrite(docId, threadId, id)),
      )
    )
      .flat()
      .filter((row) => row.status === "active"),
  );
}

async function targetSeqsForRedo(
  journal: UpdateJournal,
  docId: string,
  threadId: string,
  writeId: string,
  undoUpdateSeq: number,
): Promise<ReadonlySet<number>> {
  return mutationSeqs(
    (
      await Promise.all(
        writeId
          .split(",")
          .map((id) => requiredMutationQueries(journal).mutationsForWrite(docId, threadId, id)),
      )
    )
      .flat()
      .filter((row) => row.status === "reversed" && row.undoUpdateSeq === undoUpdateSeq),
  );
}

function mutationSeqs(rows: readonly WriteMutationRow[]): ReadonlySet<number> {
  return new Set(rows.map((row) => row.createdSeq));
}

type DependentUndoGuardResult = { ok: true } | { ok: false; blockingWriteIds: readonly string[] };

interface IdRange {
  client: number;
  clock: number;
  len: number;
}

interface DecodedUpdateLike {
  structs?: readonly { id?: { client: number; clock: number }; length?: number }[];
  ds?: { clients?: Map<number, readonly { clock: number; len: number }[]> };
}

async function guardDependentUndo(
  journal: UpdateJournal,
  input: ReversalGuardInput,
): Promise<DependentUndoGuardResult> {
  const snapshot = await journal.read(input.docId, { fromCheckpoint: false });
  const selectedInsertedIds = insertedIdRanges(
    snapshot.updates.filter((update) => input.targetSeqs.has(update.seq)),
  );
  if (selectedInsertedIds.length === 0) return { ok: true };

  const selectedSeqs = input.targetSeqs;
  const lastSelectedSeq = Math.max(...selectedSeqs);
  const seqToHandle = await writeHandlesByUpdateSeq(journal, input);
  const blockingWriteIds = new Set<string>();
  let hasUnknownBlocker = false;

  for (const update of snapshot.updates) {
    if (update.seq <= lastSelectedSeq || selectedSeqs.has(update.seq)) continue;
    if (!deleteSetIntersects(update, selectedInsertedIds)) continue;
    const handle = seqToHandle.get(update.seq);
    if (handle) {
      if (!input.target.writeIds.includes(handle)) blockingWriteIds.add(handle);
    } else {
      hasUnknownBlocker = true;
    }
  }

  if (blockingWriteIds.size === 0 && !hasUnknownBlocker) return { ok: true };
  return {
    ok: false,
    blockingWriteIds: sortWriteHandles([
      ...blockingWriteIds,
      ...(hasUnknownBlocker ? ["a later edit"] : []),
    ]),
  };
}

function insertedIdRanges(updates: readonly PersistedUpdate[]): IdRange[] {
  const ranges: IdRange[] = [];
  for (const update of updates) {
    const decoded = Y.decodeUpdate(update.update) as DecodedUpdateLike;
    for (const struct of decoded.structs ?? []) {
      const id = struct.id;
      const len = struct.length ?? 0;
      if (!id || len <= 0) continue;
      ranges.push({ client: id.client, clock: id.clock, len });
    }
  }
  return ranges;
}

function deleteSetIntersects(update: PersistedUpdate, insertedRanges: readonly IdRange[]): boolean {
  const decoded = Y.decodeUpdate(update.update) as DecodedUpdateLike;
  const deleteClients = decoded.ds?.clients;
  if (!deleteClients || deleteClients.size === 0) return false;
  for (const inserted of insertedRanges) {
    const deletes = deleteClients.get(inserted.client) ?? [];
    for (const deleted of deletes) {
      if (rangesIntersect(inserted.clock, inserted.len, deleted.clock, deleted.len)) return true;
    }
  }
  return false;
}

function rangesIntersect(leftClock: number, leftLen: number, rightClock: number, rightLen: number) {
  return leftClock < rightClock + rightLen && rightClock < leftClock + leftLen;
}

async function writeHandlesByUpdateSeq(
  journal: UpdateJournal,
  input: ReversalGuardInput,
): Promise<Map<number, string>> {
  const handles = new Set(input.target.writeIds);
  for (const summary of await requiredMutationQueries(journal).activeWriteSummary(
    input.docId,
    input.threadId,
  )) {
    handles.add(summary.handle);
  }
  for (const reversal of await journal.readReversals(input.docId, { threadId: input.threadId })) {
    if (reversal.writeId) handles.add(reversal.writeId);
    for (const writeId of reversal.writeIds ?? []) handles.add(writeId);
  }

  const seqToHandle = new Map<number, string>();
  for (const handle of handles) {
    if (!isWriteHandle(handle)) continue;
    const rows = await requiredMutationQueries(journal).mutationsForWrite(
      input.docId,
      input.threadId,
      handle,
    );
    for (const row of rows) seqToHandle.set(row.createdSeq, row.handle);
  }
  for (const reversal of await journal.readReversals(input.docId, { threadId: input.threadId })) {
    const handle = reversal.writeId ?? reversal.writeIds?.[0];
    if (handle) seqToHandle.set(reversal.undoUpdateSeq, handle);
  }
  return seqToHandle;
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

function sortWriteHandles(handles: readonly string[]): string[] {
  return [...handles].sort((left, right) => {
    const leftOrdinal = parseWriteHandle(left);
    const rightOrdinal = parseWriteHandle(right);
    if (leftOrdinal !== undefined && rightOrdinal !== undefined) return leftOrdinal - rightOrdinal;
    if (leftOrdinal !== undefined) return -1;
    if (rightOrdinal !== undefined) return 1;
    return left.localeCompare(right);
  });
}

function isWriteHandle(handle: string): boolean {
  return parseWriteHandle(handle) !== undefined;
}

function combineTargets<T extends { writeId: string; turnId: string; undoUpdateSeq?: number }>(
  targets: T[],
): ReversalTarget {
  return {
    writeId: targets.map((target) => target.writeId).join(","),
    writeIds: targets.map((target) => target.writeId),
    turnId: targets[0]?.turnId ?? "unknown",
    ...(targets[0]?.undoUpdateSeq !== undefined ? { undoUpdateSeq: targets[0].undoUpdateSeq } : {}),
  };
}

async function selectUndoTargets(
  selection: ReversalSelection,
  input: { journal: UpdateJournal; docId: string; threadId: string },
): Promise<{ writeId: string; turnId: string }[]> {
  const base = {
    journal: input.journal,
    mutationQueries: requiredMutationQueries(input.journal),
    docId: input.docId,
    threadId: input.threadId,
  };
  if (selection.kind === "latest") {
    const target = await latestUndoableWrite(base);
    return target ? [target] : [];
  }
  if (selection.kind === "single") {
    const target = await specificUndoableWrite({ ...base, writeId: selection.to });
    return target ? [target] : [];
  }
  const all = await undoableWrites(base);
  if (selection.kind === "all") return all;
  if (selection.kind === "last") return all.slice(-selection.count);
  return all.filter((target) => target.writeId >= selection.from && target.writeId <= selection.to);
}

async function selectRedoTargets(
  selection: ReversalSelection,
  input: { journal: UpdateJournal; docId: string; threadId: string },
): Promise<{ writeId: string; turnId: string; undoUpdateSeq: number }[]> {
  const base = {
    journal: input.journal,
    mutationQueries: requiredMutationQueries(input.journal),
    docId: input.docId,
    threadId: input.threadId,
  };
  if (selection.kind === "latest") {
    const target = await latestRedoableTarget(base);
    return target ? [target] : [];
  }
  if (selection.kind === "single") {
    const target = await specificRedoableTarget({ ...base, writeId: selection.to });
    return target ? [target] : [];
  }
  const all = await redoableTargets(base);
  if (selection.kind === "all") return all;
  if (selection.kind === "last") return all.slice(-selection.count);
  const selected = all.filter(
    (target) => target.writeId >= selection.from && target.writeId <= selection.to,
  );
  const undoSeq = selected[0]?.undoUpdateSeq;
  return undoSeq === undefined ? [] : selected.filter((target) => target.undoUpdateSeq === undoSeq);
}

function formatCause(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : String(cause);
}

function defaultInvariantViolation(message: string): never {
  throw new Error(message);
}
