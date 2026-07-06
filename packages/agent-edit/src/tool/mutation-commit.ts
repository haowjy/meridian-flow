// Commits local Yjs mutations to the journal and live document projection.
import * as Y from "yjs";
import {
  applyConcurrentUpdates,
  type BlockSnapshot,
  type ConcurrentDetectionResult,
  computeEcho,
  snapshotBlocks,
} from "../apply/echo.js";
import type {
  ApplyEchoHunk,
  ConcurrentEditInfo,
  ConcurrentUpdate,
  ConcurrentUpdateOrigin,
} from "../apply/types.js";
import type { AgentEditCodec } from "../codec-adapter.js";
import { toDocHandle } from "../handles.js";
import type { DocumentCoordinator } from "../ports/document-coordinator.js";
import type { AgentEditModel } from "../ports/model.js";
import type { UpdateMeta } from "../ports/types.js";
import type {
  JournalBatchAppendEntry,
  JournalBatchAppendResult,
  UpdateJournal,
} from "../ports/update-journal.js";
import { effectiveYjsUpdate } from "../yjs-update.js";
import { withLiveDocument } from "./coordinator.js";
import { type InternalWriteResult, isInternalWriteResult } from "./internal-result.js";
import type { WriteCommand } from "./types.js";

export interface MutationCommitRuntime {
  doc: Y.Doc;
}

export interface SyncedMutationSummary {
  echo: ApplyEchoHunk[];
  concurrentEdits?: ConcurrentEditInfo;
  reconciled: boolean;
}

export interface MutationEchoInput {
  runtime: MutationCommitRuntime;
  before: readonly BlockSnapshot[];
  touchedHashes: ReadonlySet<string>;
  deletedHashes: ReadonlySet<string>;
  /** Precomputed post-re-sync snapshot — when supplied, skips the per-call snapshotBlocks. */
  afterSnapshot?: readonly BlockSnapshot[];
}

export interface JournaledUpdate {
  update: Uint8Array;
  meta: UpdateMeta;
  mutation?: JournalBatchAppendEntry["mutation"];
}

export interface LiveUpdateCommitInput {
  docId: string;
  commandName: WriteCommand["command"];
  updates: readonly JournaledUpdate[];
  afterOwnVector: Uint8Array;
  liveOrigin: ConcurrentUpdateOrigin;
  committedSnapshot?: Uint8Array;
  afterJournalId?: number;
  attemptId?: string;
}

export interface LiveProjectionInput extends LiveUpdateCommitInput {
  turnId?: string;
}

export interface LocalMutationSyncInput {
  docId: string;
  commandName: WriteCommand["command"];
  runtime: MutationCommitRuntime;
  update: Uint8Array;
  meta?: UpdateMeta;
  mutation?: JournaledUpdate["mutation"];
  afterOwnVector: Uint8Array;
  liveOrigin: ConcurrentUpdateOrigin;
  before: readonly BlockSnapshot[];
  touchedHashes: ReadonlySet<string>;
  deletedHashes: ReadonlySet<string>;
  ownTurnId?: string;
  committedSnapshot?: Uint8Array;
  afterJournalId?: number;
}

type LiveCommitResult =
  | { ok: true; concurrentUpdates: ConcurrentUpdate[]; journalResults?: JournalBatchAppendResult[] }
  | { ok: false; response: InternalWriteResult };

type MutationSyncResult =
  | { ok: true; summary: SyncedMutationSummary; journalResults?: JournalBatchAppendResult[] }
  | { ok: false; response: InternalWriteResult };

type LiveProjectionResult =
  | { ok: true; concurrent: ConcurrentDetectionResult }
  | { ok: false; response: InternalWriteResult };

export interface MutationCommit {
  syncAfterLocalMutation(input: LocalMutationSyncInput): Promise<MutationSyncResult>;
  commitImmediate(input: LiveUpdateCommitInput): Promise<LiveCommitResult>;
  commitJournalBatch(
    entries: readonly JournalBatchAppendEntry[],
  ): Promise<JournalBatchAppendResult[]>;
  projectToLive(
    runtime: MutationCommitRuntime,
    input: LiveProjectionInput,
  ): Promise<LiveProjectionResult>;
  summarizeMutationEcho(
    input: MutationEchoInput,
    concurrent?: ConcurrentDetectionResult,
  ): SyncedMutationSummary;
  detectConcurrentEdits(input: {
    docId: string;
    runtime: MutationCommitRuntime;
    agentUpdate: Uint8Array;
    committedSnapshot?: Uint8Array;
    preOwnSnapshot?: Uint8Array;
    ownTurnId?: string;
    afterJournalId?: number;
    attemptId?: string;
  }): Promise<ConcurrentDetectionResult>;
}

export function createMutationCommit(deps: {
  journal: UpdateJournal;
  coordinator: DocumentCoordinator;
  model: AgentEditModel;
  codec: AgentEditCodec;
}): MutationCommit {
  const { journal, coordinator, model, codec } = deps;

  return {
    syncAfterLocalMutation,
    commitImmediate,
    commitJournalBatch,
    projectToLive,
    summarizeMutationEcho,
    detectConcurrentEdits,
  };

  async function syncAfterLocalMutation(
    input: LocalMutationSyncInput,
  ): Promise<MutationSyncResult> {
    const detection = detectionBaseline(input.runtime, input.committedSnapshot);
    try {
      const journalResults = input.meta
        ? await commitJournalBatch([
            {
              docId: input.docId,
              update: input.update,
              meta: input.meta,
              ...(input.mutation ? { mutation: input.mutation } : {}),
            },
          ])
        : undefined;
      const committed = await mergeCommittedUpdateToLive({
        docId: input.docId,
        commandName: input.commandName,
        update: input.update,
        afterOwnVector: input.afterOwnVector,
        concurrentBaselineVector: detection.vector,
        concurrentBaselineDoc: detection.doc,
        liveOrigin: input.liveOrigin,
        afterJournalId: input.afterJournalId,
      });
      if (!committed.ok) return { ok: false, response: committed.response };
      const concurrent = applyConcurrentOnDoc(
        detection.doc,
        input.runtime,
        committed.concurrentUpdates,
        detection.vector,
        input.ownTurnId,
      );
      return {
        ok: true,
        summary: summarizeMutationEcho(input, concurrent),
        journalResults,
      };
    } finally {
      detection.destroy?.();
    }
  }

  function summarizeMutationEcho(
    input: MutationEchoInput,
    concurrent: ConcurrentDetectionResult = { touchedHashes: new Set() },
  ): SyncedMutationSummary {
    const after =
      input.afterSnapshot ?? snapshotBlocks(toDocHandle(input.runtime.doc), model, codec);
    const echo = computeEcho({
      before: input.before,
      after,
      agentTouchedHashes: input.touchedHashes,
      agentDeletedHashes: input.deletedHashes,
    });
    return {
      echo,
      concurrentEdits: concurrent.info,
      reconciled: echo.some((hunk) => hunk.mode === "full"),
    };
  }

  async function detectConcurrentEdits(input: {
    docId: string;
    runtime: MutationCommitRuntime;
    agentUpdate: Uint8Array;
    committedSnapshot?: Uint8Array;
    preOwnSnapshot?: Uint8Array;
    ownTurnId?: string;
    afterJournalId?: number;
    attemptId?: string;
  }): Promise<ConcurrentDetectionResult> {
    const detection = detectionBaseline(input.runtime, input.committedSnapshot);
    const preOwnDoc = input.preOwnSnapshot ? docFromSnapshot(input.preOwnSnapshot) : undefined;
    try {
      const updates = await concurrentUpdatesSince(
        coordinator,
        input.docId,
        preOwnDoc ?? input.runtime.doc,
        detection.doc,
        detection.vector,
        input.afterJournalId,
        input.attemptId,
      );
      return applyConcurrentOnDoc(
        detection.doc,
        input.runtime,
        updates,
        detection.vector,
        input.ownTurnId,
      );
    } finally {
      preOwnDoc?.destroy();
      detection.destroy?.();
    }
  }

  async function commitImmediate(input: LiveUpdateCommitInput): Promise<LiveCommitResult> {
    const journalResults = await commitJournalBatch(journalEntries(input));

    const committed = await mergeCommittedUpdatesToLive(input);
    return committed.ok ? { ...committed, journalResults } : committed;
  }

  async function commitJournalBatch(
    entries: readonly JournalBatchAppendEntry[],
  ): Promise<JournalBatchAppendResult[]> {
    return journal.appendBatch(entries);
  }

  async function projectToLive(
    runtime: MutationCommitRuntime,
    input: LiveProjectionInput,
  ): Promise<LiveProjectionResult> {
    const detection = detectionBaseline(runtime, input.committedSnapshot);
    try {
      const committed = await mergeCommittedUpdatesToLive({
        ...input,
        concurrentBaselineVector: detection.vector,
        concurrentBaselineDoc: detection.doc,
      });
      if (!committed.ok) return { ok: false, response: committed.response };
      const concurrent = applyConcurrentOnDoc(
        detection.doc,
        runtime,
        committed.concurrentUpdates,
        detection.vector,
        input.turnId,
      );
      return { ok: true, concurrent };
    } finally {
      detection.destroy?.();
    }
  }

  async function mergeCommittedUpdatesToLive(
    input: LiveUpdateCommitInput & {
      concurrentBaselineVector?: Uint8Array;
      concurrentBaselineDoc?: Y.Doc;
    },
  ): Promise<LiveCommitResult> {
    return mergeCommittedUpdateToLive({
      docId: input.docId,
      commandName: input.commandName,
      update: mergeUpdates(input.updates.map((entry) => entry.update)),
      afterOwnVector: input.afterOwnVector,
      concurrentBaselineVector: input.concurrentBaselineVector,
      concurrentBaselineDoc: input.concurrentBaselineDoc,
      liveOrigin: input.liveOrigin,
      afterJournalId: input.afterJournalId,
      attemptId: input.updates.at(-1)?.mutation?.writeId,
    });
  }

  async function mergeCommittedUpdateToLive(input: {
    docId: string;
    commandName: WriteCommand["command"];
    update: Uint8Array;
    afterOwnVector: Uint8Array;
    concurrentBaselineVector?: Uint8Array;
    concurrentBaselineDoc?: Y.Doc;
    liveOrigin: ConcurrentUpdateOrigin;
    afterJournalId?: number;
    attemptId?: string;
  }): Promise<LiveCommitResult> {
    const concurrentUpdates = await mergeUpdateAndCaptureConcurrent(input);
    if (isInternalWriteResult(concurrentUpdates)) return { ok: false, response: concurrentUpdates };
    return { ok: true, concurrentUpdates };
  }

  async function mergeUpdateAndCaptureConcurrent(input: {
    docId: string;
    commandName: WriteCommand["command"];
    update: Uint8Array;
    afterOwnVector: Uint8Array;
    concurrentBaselineVector?: Uint8Array;
    concurrentBaselineDoc?: Y.Doc;
    liveOrigin: ConcurrentUpdateOrigin;
    afterJournalId?: number;
    attemptId?: string;
  }): Promise<ConcurrentUpdate[] | InternalWriteResult> {
    let concurrentUpdates: ConcurrentUpdate[] = [];
    const response = await withLiveDocument(
      coordinator,
      input.docId,
      input.commandName,
      input.docId,
      async (liveDoc) => {
        const baseline = input.concurrentBaselineVector ?? input.afterOwnVector;
        concurrentUpdates = await concurrentUpdatesSince(
          coordinator,
          input.docId,
          liveDoc,
          input.concurrentBaselineDoc,
          baseline,
          input.afterJournalId,
          input.attemptId,
        );
        Y.applyUpdate(liveDoc, input.update, input.liveOrigin);
        return null;
      },
    );
    if (isInternalWriteResult(response)) return response;
    return concurrentUpdates;
  }

  function applyConcurrentOnDoc(
    detectionDoc: Y.Doc,
    runtime: MutationCommitRuntime,
    updates: readonly ConcurrentUpdate[],
    _syncVector: Uint8Array,
    turnId: string | undefined,
  ): ConcurrentDetectionResult {
    if (updates.length === 0) return { touchedHashes: new Set() };
    const result = applyConcurrentUpdates(
      toDocHandle(detectionDoc),
      model,
      codec,
      updates,
      turnId ? agentUpdateOrigin(turnId) : undefined,
    );
    if (detectionDoc !== runtime.doc) {
      for (const item of updates) {
        if (item.update.length > 0) Y.applyUpdate(runtime.doc, item.update, item.origin);
      }
    }
    return result;
  }

  function detectionBaseline(
    runtime: MutationCommitRuntime,
    committedSnapshot: Uint8Array | undefined,
  ): { doc: Y.Doc; vector: Uint8Array; destroy?: () => void } {
    if (!committedSnapshot) return { doc: runtime.doc, vector: Y.encodeStateVector(runtime.doc) };

    const detectionDoc = docFromSnapshot(committedSnapshot);
    return {
      doc: detectionDoc,
      vector: Y.encodeStateVector(detectionDoc),
      destroy: () => detectionDoc.destroy(),
    };
  }
}

function docFromSnapshot(snapshot: Uint8Array): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, snapshot, { type: "system" });
  return doc;
}

async function concurrentUpdatesSince(
  coordinator: DocumentCoordinator,
  docId: string,
  doc: Y.Doc,
  baselineDoc: Y.Doc | undefined,
  sinceStateVector: Uint8Array,
  afterJournalId?: number,
  attemptId?: string,
): Promise<ConcurrentUpdate[]> {
  if (coordinator.concurrentUpdatesSince) {
    return coordinator.concurrentUpdatesSince({
      docId,
      doc,
      baselineDoc,
      sinceStateVector,
      afterJournalId,
      attemptId,
    });
  }
  const update = Y.encodeStateAsUpdate(doc, sinceStateVector);
  const probe = baselineDoc ?? new Y.Doc({ gc: false });
  try {
    return effectiveYjsUpdate(probe, update) ? [{ update, origin: { type: "human" } }] : [];
  } finally {
    if (!baselineDoc) probe.destroy();
  }
}

function mergeUpdates(updates: Uint8Array[]): Uint8Array {
  return updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
}

function journalEntries(input: LiveUpdateCommitInput): JournalBatchAppendEntry[] {
  return input.updates.map((entry) => ({
    docId: input.docId,
    update: entry.update,
    meta: entry.meta,
    ...(entry.mutation ? { mutation: entry.mutation } : {}),
  }));
}

function agentUpdateOrigin(turnId: string): ConcurrentUpdateOrigin & { type: "agent" } {
  return { type: "agent", actorTurnId: turnId };
}
