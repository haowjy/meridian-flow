// Commits local Yjs mutations to the journal and live document projection.
import * as Y from "yjs";

import {
  applyConcurrentUpdates,
  type BlockSnapshot,
  type ConcurrentDetectionResult,
  computeEcho,
  snapshotBlocks,
} from "../apply/echo.js";
import type { ApplyEchoHunk, ConcurrentEditInfo, ConcurrentUpdateOrigin } from "../apply/types.js";
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
import { withLiveDocument } from "./coordinator.js";
import { type InternalWriteResult, isInternalWriteResult } from "./internal-result.js";
import type { WriteCommand } from "./types.js";

const EMPTY_UPDATE_LENGTH = 2;

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
}

type LiveCommitResult =
  | { ok: true; concurrentUpdate: Uint8Array | null; journalResults?: JournalBatchAppendResult[] }
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
  };

  async function syncAfterLocalMutation(
    input: LocalMutationSyncInput,
  ): Promise<MutationSyncResult> {
    const detection = detectionBaseline(input.runtime, input.update, input.committedSnapshot);
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
        liveOrigin: input.liveOrigin,
      });
      if (!committed.ok) return { ok: false, response: committed.response };
      const concurrent = applyConcurrentOnDoc(
        detection.doc,
        input.runtime,
        committed.concurrentUpdate,
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
    const detection = detectionBaseline(
      runtime,
      mergeUpdates(input.updates.map((entry) => entry.update)),
      input.committedSnapshot,
    );
    try {
      const committed = await mergeCommittedUpdatesToLive({
        ...input,
        concurrentBaselineVector: detection.vector,
      });
      if (!committed.ok) return { ok: false, response: committed.response };
      const concurrent = applyConcurrentOnDoc(
        detection.doc,
        runtime,
        committed.concurrentUpdate,
        detection.vector,
        input.turnId,
      );
      return { ok: true, concurrent };
    } finally {
      detection.destroy?.();
    }
  }

  async function mergeCommittedUpdatesToLive(
    input: LiveUpdateCommitInput & { concurrentBaselineVector?: Uint8Array },
  ): Promise<LiveCommitResult> {
    return mergeCommittedUpdateToLive({
      docId: input.docId,
      commandName: input.commandName,
      update: mergeUpdates(input.updates.map((entry) => entry.update)),
      afterOwnVector: input.afterOwnVector,
      concurrentBaselineVector: input.concurrentBaselineVector,
      liveOrigin: input.liveOrigin,
    });
  }

  async function mergeCommittedUpdateToLive(input: {
    docId: string;
    commandName: WriteCommand["command"];
    update: Uint8Array;
    afterOwnVector: Uint8Array;
    concurrentBaselineVector?: Uint8Array;
    liveOrigin: ConcurrentUpdateOrigin;
  }): Promise<LiveCommitResult> {
    const concurrentUpdate = await mergeUpdateAndCaptureConcurrent(input);
    if (isInternalWriteResult(concurrentUpdate)) return { ok: false, response: concurrentUpdate };
    return { ok: true, concurrentUpdate };
  }

  async function mergeUpdateAndCaptureConcurrent(input: {
    docId: string;
    commandName: WriteCommand["command"];
    update: Uint8Array;
    afterOwnVector: Uint8Array;
    concurrentBaselineVector?: Uint8Array;
    liveOrigin: ConcurrentUpdateOrigin;
  }): Promise<Uint8Array | null | InternalWriteResult> {
    let concurrentUpdate: Uint8Array | null = null;
    const response = await withLiveDocument(
      coordinator,
      input.docId,
      input.commandName,
      input.docId,
      async (liveDoc) => {
        const baseline = input.concurrentBaselineVector ?? input.afterOwnVector;
        concurrentUpdate = Y.encodeStateAsUpdate(liveDoc, baseline);
        Y.applyUpdate(liveDoc, input.update, input.liveOrigin);
        return null;
      },
    );
    if (isInternalWriteResult(response)) return response;
    return concurrentUpdate;
  }

  function applyConcurrentOnDoc(
    detectionDoc: Y.Doc,
    runtime: MutationCommitRuntime,
    update: Uint8Array | null,
    syncVector: Uint8Array,
    turnId: string | undefined,
  ): ConcurrentDetectionResult {
    if (!update || !hasYjsUpdate(update)) return { touchedHashes: new Set() };
    const result = applyConcurrentUpdates(
      toDocHandle(detectionDoc),
      model,
      codec,
      [{ update, origin: { type: "human" } }],
      turnId ? agentUpdateOrigin(turnId) : undefined,
      syncVector,
    );
    if (detectionDoc !== runtime.doc) {
      Y.applyUpdate(runtime.doc, update, { type: "human" });
    }
    return result;
  }

  function detectionBaseline(
    runtime: MutationCommitRuntime,
    agentUpdate: Uint8Array,
    committedSnapshot: Uint8Array | undefined,
  ): { doc: Y.Doc; vector: Uint8Array; destroy?: () => void } {
    if (!committedSnapshot) return { doc: runtime.doc, vector: Y.encodeStateVector(runtime.doc) };

    const detectionDoc = new Y.Doc({ gc: false });
    Y.applyUpdate(detectionDoc, committedSnapshot, { type: "system" });
    if (hasYjsUpdate(agentUpdate)) Y.applyUpdate(detectionDoc, agentUpdate, { type: "agent" });
    return {
      doc: detectionDoc,
      vector: Y.encodeStateVector(detectionDoc),
      destroy: () => detectionDoc.destroy(),
    };
  }
}

function hasYjsUpdate(update: Uint8Array): boolean {
  return update.length > EMPTY_UPDATE_LENGTH;
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
