// Commits local Yjs mutations to the journal and live document projection.
import * as Y from "yjs";

import {
  applyConcurrentUpdates,
  type BlockSnapshot,
  type ConcurrentDetectionResult,
  computeEcho,
  fullEchoForTouchedBlocks,
  snapshotBlocks,
} from "../apply/echo.js";
import type { ApplyEchoHunk, ConcurrentEditInfo, ConcurrentUpdateOrigin } from "../apply/types.js";
import type { Codec } from "../codec/types.js";
import type { DocumentCoordinator } from "../ports/document-coordinator.js";
import type { AgentEditModel } from "../ports/model.js";
import type { UpdateMeta } from "../ports/types.js";
import type { JournalBatchAppendEntry, UpdateJournal } from "../ports/update-journal.js";
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
  structuralChange: boolean;
}

export interface JournaledUpdate {
  update: Uint8Array;
  meta: UpdateMeta;
  mutation?: {
    threadId: string;
    turnId: string;
  };
}

export interface LiveUpdateCommitInput {
  docId: string;
  commandName: WriteCommand["command"];
  updates: readonly JournaledUpdate[];
  afterOwnVector: Uint8Array;
  liveOrigin: ConcurrentUpdateOrigin;
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
  structuralChange: boolean;
  ownTurnId?: string;
}

type LiveCommitResult =
  | { ok: true; concurrentUpdate: Uint8Array | null }
  | { ok: false; response: InternalWriteResult };

type MutationSyncResult =
  | { ok: true; summary: SyncedMutationSummary }
  | { ok: false; response: InternalWriteResult };

type LiveProjectionResult =
  | { ok: true; concurrent: ConcurrentDetectionResult; echo: ApplyEchoHunk[] }
  | { ok: false; response: InternalWriteResult };

export interface MutationCommit {
  syncAfterLocalMutation(input: LocalMutationSyncInput): Promise<MutationSyncResult>;
  commitImmediate(input: LiveUpdateCommitInput): Promise<LiveCommitResult>;
  commitJournalBatch(entries: readonly JournalBatchAppendEntry[]): Promise<void>;
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
  codec: Codec;
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
    const committed = input.meta
      ? await commitImmediate({
          docId: input.docId,
          commandName: input.commandName,
          updates: [
            {
              update: input.update,
              meta: input.meta,
              ...(input.mutation ? { mutation: input.mutation } : {}),
            },
          ],
          afterOwnVector: input.afterOwnVector,
          liveOrigin: input.liveOrigin,
        })
      : await mergeCommittedUpdateToLive({
          docId: input.docId,
          commandName: input.commandName,
          update: input.update,
          afterOwnVector: input.afterOwnVector,
          liveOrigin: input.liveOrigin,
        });
    if (!committed.ok) return { ok: false, response: committed.response };
    const concurrent = applyConcurrent(
      input.runtime,
      committed.concurrentUpdate,
      input.afterOwnVector,
      input.ownTurnId,
    );
    return { ok: true, summary: summarizeMutationEcho(input, concurrent) };
  }

  function summarizeMutationEcho(
    input: MutationEchoInput,
    concurrent: ConcurrentDetectionResult = { touchedHashes: new Set() },
  ): SyncedMutationSummary {
    const after = snapshotBlocks(input.runtime.doc, model, codec);
    const baseEchoInput = {
      before: input.before,
      after,
      agentTouchedHashes: input.touchedHashes,
      agentDeletedHashes: input.deletedHashes,
      structuralChange: input.structuralChange,
      concurrentTouchedHashes: concurrent.touchedHashes,
    };
    const echo = computeEcho(baseEchoInput);
    const regroundingEcho =
      echo.length > 0 || (input.touchedHashes.size === 0 && input.deletedHashes.size === 0)
        ? echo
        : computeEcho({ ...baseEchoInput, structuralChange: true });
    return {
      echo: regroundingEcho,
      concurrentEdits: concurrent.info,
      reconciled: echo.some((hunk) => hunk.mode === "full"),
    };
  }

  async function commitImmediate(input: LiveUpdateCommitInput): Promise<LiveCommitResult> {
    await commitJournalBatch(journalEntries(input));

    return mergeCommittedUpdatesToLive(input);
  }

  async function commitJournalBatch(entries: readonly JournalBatchAppendEntry[]): Promise<void> {
    await journal.appendBatch(entries);
  }

  async function projectToLive(
    runtime: MutationCommitRuntime,
    input: LiveProjectionInput,
  ): Promise<LiveProjectionResult> {
    const committed = await mergeCommittedUpdatesToLive(input);
    if (!committed.ok) return { ok: false, response: committed.response };
    const concurrent = applyConcurrent(
      runtime,
      committed.concurrentUpdate,
      input.afterOwnVector,
      input.turnId,
    );
    return {
      ok: true,
      concurrent,
      echo: concurrent.info
        ? fullEchoForTouchedBlocks(
            snapshotBlocks(runtime.doc, model, codec),
            concurrent.touchedHashes,
          )
        : [],
    };
  }

  async function mergeCommittedUpdatesToLive(
    input: LiveUpdateCommitInput,
  ): Promise<LiveCommitResult> {
    return mergeCommittedUpdateToLive({
      docId: input.docId,
      commandName: input.commandName,
      update: mergeUpdates(input.updates.map((entry) => entry.update)),
      afterOwnVector: input.afterOwnVector,
      liveOrigin: input.liveOrigin,
    });
  }

  async function mergeCommittedUpdateToLive(input: {
    docId: string;
    commandName: WriteCommand["command"];
    update: Uint8Array;
    afterOwnVector: Uint8Array;
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
    liveOrigin: ConcurrentUpdateOrigin;
  }): Promise<Uint8Array | null | InternalWriteResult> {
    let concurrentUpdate: Uint8Array | null = null;
    const response = await withLiveDocument(
      coordinator,
      input.docId,
      input.commandName,
      async (liveDoc) => {
        concurrentUpdate = Y.encodeStateAsUpdate(liveDoc, input.afterOwnVector);
        Y.applyUpdate(liveDoc, input.update, input.liveOrigin);
        return null;
      },
    );
    if (isInternalWriteResult(response)) return response;
    return concurrentUpdate;
  }

  function applyConcurrent(
    runtime: MutationCommitRuntime,
    update: Uint8Array | null,
    afterOwnVector: Uint8Array,
    turnId: string | undefined,
  ): ConcurrentDetectionResult {
    if (!update || !hasYjsUpdate(update)) return { touchedHashes: new Set() };
    return applyConcurrentUpdates(
      runtime.doc,
      model,
      codec,
      [{ update, origin: { type: "human" } }],
      turnId ? agentUpdateOrigin(turnId) : undefined,
      afterOwnVector,
    );
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
