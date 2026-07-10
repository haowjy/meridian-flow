// Journal batch commit and live projection for mutating writes.
import * as Y from "yjs";

import {
  applyConcurrentUpdates,
  type BlockSnapshot,
  type ConcurrentDetectionResult,
  computeEcho,
  diffSnapshots,
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
  JournalCommitKind,
  UpdateJournal,
} from "../ports/update-journal.js";
import { effectiveYjsUpdate } from "../yjs-update.js";
import { withLiveDocument } from "./coordinator.js";
import { type InternalWriteResult, isInternalWriteResult } from "./internal-result.js";
import { status } from "./response-format.js";
import type { InteractionContext, WriteCommand } from "./types.js";

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
  interactionContext?: InteractionContext;
}

export interface LiveProjectionInput extends LiveUpdateCommitInput {
  touchedHashes: ReadonlySet<string>;
  deletedHashes: ReadonlySet<string>;
  preOwnSnapshot?: Uint8Array;
  turnId?: string;
}

export interface ImmediateCommitInput extends LiveProjectionInput {
  runtime: MutationCommitRuntime;
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
  interactionContext?: InteractionContext;
  preOwnSnapshot?: Uint8Array;
}

export interface SafetyGateInput {
  docId: string;
  runtime: MutationCommitRuntime;
  afterOwnVector: Uint8Array;
  deletedHashes: ReadonlySet<string>;
  interactionContext?: InteractionContext;
  preOwnSnapshot?: Uint8Array;
  ownTurnId?: string;
}

export interface CapturedConcurrentDetection {
  updates: readonly ConcurrentUpdate[];
  detection: ConcurrentDetectionResult;
  detectionSnapshot: Uint8Array;
  liveStateVector: Uint8Array;
}

export type SafetyGateResult =
  | { verdict: "pass"; concurrent: CapturedConcurrentDetection }
  | { verdict: "reject"; conflictedBlockHashes: string[] };

export interface DestructiveSweepReport {
  affectedBlockHashes: string[];
  capturedDeletedBodies?: { hash: string; body: string }[];
  sweptContent: true;
  beforeContentRef: number | null;
}

export interface ApplyWithRecheckResult {
  concurrent: CapturedConcurrentDetection;
  lateSweep?: DestructiveSweepReport;
}

export type JournalBatchCommit = {
  journalCommitKind: JournalCommitKind;
};

type LiveCommitResult =
  | {
      ok: true;
      concurrentUpdates: ConcurrentUpdate[];
      journalCommitKind: JournalCommitKind;
      lateSweep?: DestructiveSweepReport;
    }
  | { ok: false; response: InternalWriteResult; journalCommitKind: JournalCommitKind | null };

type MutationSyncResult =
  | {
      ok: true;
      summary: SyncedMutationSummary;
      journalCommitKind: JournalCommitKind | null;
      lateSweep?: DestructiveSweepReport;
    }
  | {
      ok: false;
      response: InternalWriteResult;
      journalCommitKind: JournalCommitKind | null;
    };

export interface MutationCommit {
  syncAfterLocalMutation(input: LocalMutationSyncInput): Promise<MutationSyncResult>;
  commitImmediate(input: ImmediateCommitInput): Promise<LiveCommitResult>;
  commitJournalBatch(entries: readonly JournalBatchAppendEntry[]): Promise<JournalBatchCommit>;
  summarizeMutationEcho(
    input: MutationEchoInput,
    concurrent?: ConcurrentDetectionResult,
  ): SyncedMutationSummary;
  detectConcurrentEdits(input: {
    docId: string;
    runtime: MutationCommitRuntime;
    agentUpdate: Uint8Array;
    interactionContext?: InteractionContext;
    preOwnSnapshot?: Uint8Array;
    ownTurnId?: string;
  }): Promise<ConcurrentDetectionResult>;
  preflightSafetyGate(liveDoc: Y.Doc, input: SafetyGateInput): Promise<SafetyGateResult>;
  applyCommittedUpdateWithRecheck(
    liveDoc: Y.Doc,
    input: SafetyGateInput & { update: Uint8Array; liveOrigin: ConcurrentUpdateOrigin },
    preflight?: CapturedConcurrentDetection,
  ): Promise<ApplyWithRecheckResult>;
  recheckCommittedUpdate(liveDoc: Y.Doc, input: SafetyGateInput): Promise<ApplyWithRecheckResult>;
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
    summarizeMutationEcho,
    detectConcurrentEdits,
    preflightSafetyGate,
    applyCommittedUpdateWithRecheck,
    recheckCommittedUpdate,
  };

  async function syncAfterLocalMutation(
    input: LocalMutationSyncInput,
  ): Promise<MutationSyncResult> {
    let captured: CapturedConcurrentDetection | undefined;
    let lateSweep: DestructiveSweepReport | undefined;
    let journalCommitKind: JournalCommitKind | null = null;
    const response = await withLiveDocument(
      coordinator,
      input.docId,
      input.commandName,
      input.docId,
      async (liveDoc) => {
        // Reversal rows are persisted by the reversal store before this seam. P2
        // will add its actor-specific reject/report policy; once durable, apply.
        if (!input.meta) {
          const applied = await applyCommittedUpdateWithRecheck(liveDoc, {
            ...input,
            update: input.update,
          });
          captured = applied.concurrent;
          return null;
        }
        const gate = await preflightSafetyGate(liveDoc, input);
        if (gate.verdict === "reject") return destructiveWriteRejection(gate.conflictedBlockHashes);
        const beforeJournalSnapshot = snapshotBlocks(toDocHandle(liveDoc), model, codec);
        const committed = await commitJournalBatch([
          {
            docId: input.docId,
            update: input.update,
            meta: input.meta,
            ...(input.mutation ? { mutation: input.mutation } : {}),
          },
        ]);
        journalCommitKind = committed.journalCommitKind;
        captured = gate.concurrent;
        const beforeApplySnapshot = snapshotBlocks(toDocHandle(liveDoc), model, codec);
        lateSweep = lateSweepFromSnapshots(input, beforeJournalSnapshot, beforeApplySnapshot);
        // INVARIANT (LOCK-WS): immediate apply remains synchronous at this site;
        // never insert an await immediately before Y.applyUpdate.
        Y.applyUpdate(liveDoc, input.update, input.liveOrigin);
        return null;
      },
    );
    if (isInternalWriteResult(response)) {
      return { ok: false, response, journalCommitKind };
    }
    const concurrent = captured
      ? applyCapturedConcurrentToRuntime(input.runtime, captured)
      : { humanTouchedHashes: new Set<string>(), touchedHashes: new Set<string>() };
    return {
      ok: true,
      summary: summarizeMutationEcho(input, concurrent),
      journalCommitKind,
      ...(lateSweep ? { lateSweep } : {}),
    };
  }

  function summarizeMutationEcho(
    input: MutationEchoInput,
    concurrent: ConcurrentDetectionResult = {
      humanTouchedHashes: new Set(),
      touchedHashes: new Set(),
    },
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
    interactionContext?: InteractionContext;
    preOwnSnapshot?: Uint8Array;
    ownTurnId?: string;
  }): Promise<ConcurrentDetectionResult> {
    const detection = detectionBaseline(input.runtime, input.interactionContext?.baselineSnapshot);
    const preOwnDoc = input.preOwnSnapshot ? docFromSnapshot(input.preOwnSnapshot) : undefined;
    try {
      const updates = await concurrentUpdatesSince(
        coordinator,
        input.docId,
        preOwnDoc ?? input.runtime.doc,
        detection.doc,
        detection.vector,
        input.interactionContext?.afterJournalId,
        input.interactionContext?.attemptId,
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

  async function commitImmediate(input: ImmediateCommitInput): Promise<LiveCommitResult> {
    let captured: CapturedConcurrentDetection | undefined;
    let lateSweep: DestructiveSweepReport | undefined;
    let journalCommitKind: JournalCommitKind | null = null;
    const response = await withLiveDocument(
      coordinator,
      input.docId,
      input.commandName,
      input.docId,
      async (liveDoc) => {
        const gate = await preflightSafetyGate(liveDoc, {
          ...input,
          ownTurnId: input.turnId,
        });
        if (gate.verdict === "reject") return destructiveWriteRejection(gate.conflictedBlockHashes);
        const beforeJournalSnapshot = snapshotBlocks(toDocHandle(liveDoc), model, codec);
        const journalCommit = await commitJournalBatch(journalEntries(input));
        journalCommitKind = journalCommit.journalCommitKind;
        captured = gate.concurrent;
        const beforeApplySnapshot = snapshotBlocks(toDocHandle(liveDoc), model, codec);
        lateSweep = lateSweepFromSnapshots(input, beforeJournalSnapshot, beforeApplySnapshot);
        // INVARIANT (LOCK-WS): immediate apply remains synchronous at this site;
        // never insert an await immediately before Y.applyUpdate.
        Y.applyUpdate(
          liveDoc,
          mergeUpdates(input.updates.map((entry) => entry.update)),
          input.liveOrigin,
        );
        return null;
      },
    );
    if (isInternalWriteResult(response)) return { ok: false, response, journalCommitKind };
    if (captured) applyCapturedConcurrentToRuntime(input.runtime, captured);
    return {
      ok: true,
      concurrentUpdates: [...(captured?.updates ?? [])],
      journalCommitKind: journalCommitKind ?? "durable",
      ...(lateSweep ? { lateSweep } : {}),
    };
  }

  async function commitJournalBatch(
    entries: readonly JournalBatchAppendEntry[],
  ): Promise<JournalBatchCommit> {
    const results = await journal.appendBatch(entries);
    const journalCommitKind = results.some(
      (result) => result.journalCommitKind === "syntheticPending",
    )
      ? "syntheticPending"
      : "durable";
    return { journalCommitKind };
  }

  async function preflightSafetyGate(
    liveDoc: Y.Doc,
    input: SafetyGateInput,
  ): Promise<SafetyGateResult> {
    const concurrent = await captureConcurrentDetection(liveDoc, input);
    const conflictedBlockHashes = intersectHashes(
      input.deletedHashes,
      concurrent.detection.humanTouchedHashes,
    );
    if (conflictedBlockHashes.length > 0) return { verdict: "reject", conflictedBlockHashes };
    return { verdict: "pass", concurrent };
  }

  async function applyCommittedUpdateWithRecheck(
    liveDoc: Y.Doc,
    input: SafetyGateInput & { update: Uint8Array; liveOrigin: ConcurrentUpdateOrigin },
    preflight?: CapturedConcurrentDetection,
  ): Promise<ApplyWithRecheckResult> {
    const beforeAwaitSnapshot = snapshotBlocks(toDocHandle(liveDoc), model, codec);
    const current = preflight
      ? await captureConcurrentDetection(liveDoc, input, preflight)
      : await captureConcurrentDetection(liveDoc, input);
    const beforeApplySnapshot = snapshotBlocks(toDocHandle(liveDoc), model, codec);
    const liveDiff = diffSnapshots(beforeAwaitSnapshot, beforeApplySnapshot);
    const liveTouchedHashes = new Set([...liveDiff.changed, ...liveDiff.deleted]);
    const affectedBlockHashes = [
      ...new Set([
        ...intersectHashes(input.deletedHashes, current.detection.humanTouchedHashes),
        ...intersectHashes(input.deletedHashes, liveTouchedHashes),
      ]),
    ];
    const capturedDeletedBodies = mergeCapturedBodies(
      affectedBlockHashes,
      beforeApplySnapshot,
      beforeAwaitSnapshot,
      snapshotFromUpdate(current.detectionSnapshot),
      ...(input.preOwnSnapshot ? [snapshotFromUpdate(input.preOwnSnapshot)] : []),
    );
    // INVARIANT (LOCK-WS): this final in-memory snapshot recheck and Y.applyUpdate
    // are one synchronous block. Never add an await between them.
    Y.applyUpdate(liveDoc, input.update, input.liveOrigin);
    return {
      concurrent: current,
      ...(affectedBlockHashes.length > 0
        ? {
            lateSweep: {
              affectedBlockHashes,
              capturedDeletedBodies,
              sweptContent: true as const,
              beforeContentRef: input.interactionContext?.afterJournalId ?? null,
            },
          }
        : {}),
    };
  }

  async function recheckCommittedUpdate(
    liveDoc: Y.Doc,
    input: SafetyGateInput,
  ): Promise<ApplyWithRecheckResult> {
    const concurrent = await captureConcurrentDetection(liveDoc, input);
    const affectedBlockHashes = intersectHashes(
      input.deletedHashes,
      concurrent.detection.humanTouchedHashes,
    );
    return {
      concurrent,
      ...(affectedBlockHashes.length > 0
        ? {
            lateSweep: {
              affectedBlockHashes,
              capturedDeletedBodies: captureSnapshotBodies(
                snapshotFromUpdate(concurrent.detectionSnapshot),
                affectedBlockHashes,
              ),
              sweptContent: true as const,
              beforeContentRef: input.interactionContext?.afterJournalId ?? null,
            },
          }
        : {}),
    };
  }

  function snapshotFromUpdate(update: Uint8Array): BlockSnapshot[] {
    const doc = docFromSnapshot(update);
    try {
      return snapshotBlocks(toDocHandle(doc), model, codec);
    } finally {
      doc.destroy();
    }
  }

  function captureSnapshotBodies(
    snapshot: readonly BlockSnapshot[],
    affectedHashes: readonly string[],
  ): { hash: string; body: string }[] {
    const affected = new Set(affectedHashes);
    return snapshot.flatMap((block) => {
      if (!affected.has(block.hash)) return [];
      const separator = block.serialized.indexOf("|");
      return [
        {
          hash: block.hash,
          body: separator < 0 ? block.serialized : block.serialized.slice(separator + 1),
        },
      ];
    });
  }

  function lateSweepFromSnapshots(
    input: SafetyGateInput,
    beforeAwaitSnapshot: readonly BlockSnapshot[],
    beforeApplySnapshot: readonly BlockSnapshot[],
  ): DestructiveSweepReport | undefined {
    const liveDiff = diffSnapshots(beforeAwaitSnapshot, beforeApplySnapshot);
    const affectedBlockHashes = intersectHashes(
      input.deletedHashes,
      new Set([...liveDiff.changed, ...liveDiff.deleted]),
    );
    if (affectedBlockHashes.length === 0) return undefined;
    return {
      affectedBlockHashes,
      capturedDeletedBodies: mergeCapturedBodies(
        affectedBlockHashes,
        beforeApplySnapshot,
        beforeAwaitSnapshot,
      ),
      sweptContent: true,
      beforeContentRef: input.interactionContext?.afterJournalId ?? null,
    };
  }

  function mergeCapturedBodies(
    affectedHashes: readonly string[],
    ...snapshots: readonly (readonly BlockSnapshot[])[]
  ): { hash: string; body: string }[] {
    const bodies = new Map<string, string>();
    for (const snapshot of snapshots) {
      for (const captured of captureSnapshotBodies(snapshot, affectedHashes)) {
        if (!bodies.has(captured.hash)) bodies.set(captured.hash, captured.body);
      }
    }
    return affectedHashes.flatMap((hash) => {
      const body = bodies.get(hash);
      return body === undefined ? [] : [{ hash, body }];
    });
  }

  async function captureConcurrentDetection(
    liveDoc: Y.Doc,
    input: SafetyGateInput,
    previous?: CapturedConcurrentDetection,
  ): Promise<CapturedConcurrentDetection> {
    const detectionDoc = previous
      ? docFromSnapshot(previous.detectionSnapshot)
      : docFromSnapshot(
          input.interactionContext?.baselineSnapshot ??
            input.preOwnSnapshot ??
            Y.encodeStateAsUpdate(input.runtime.doc),
        );
    const baselineVector = previous?.liveStateVector ?? Y.encodeStateVector(detectionDoc);
    try {
      const updates = await concurrentUpdatesSince(
        coordinator,
        input.docId,
        liveDoc,
        detectionDoc,
        baselineVector,
        input.interactionContext?.afterJournalId,
        input.interactionContext?.attemptId,
      );
      const incremental = applyConcurrentUpdates(
        toDocHandle(detectionDoc),
        model,
        codec,
        updates,
        input.ownTurnId ? agentUpdateOrigin(input.ownTurnId) : undefined,
      );
      return {
        updates: [...(previous?.updates ?? []), ...updates],
        detection: mergeConcurrentDetection(previous?.detection, incremental),
        detectionSnapshot: Y.encodeStateAsUpdate(detectionDoc),
        liveStateVector: Y.encodeStateVector(liveDoc),
      };
    } finally {
      detectionDoc.destroy();
    }
  }

  function applyCapturedConcurrentToRuntime(
    runtime: MutationCommitRuntime,
    captured: CapturedConcurrentDetection,
  ): ConcurrentDetectionResult {
    for (const item of captured.updates) {
      if (item.update.length > 0) Y.applyUpdate(runtime.doc, item.update, item.origin);
    }
    return captured.detection;
  }

  function applyConcurrentOnDoc(
    detectionDoc: Y.Doc,
    runtime: MutationCommitRuntime,
    updates: readonly ConcurrentUpdate[],
    _syncVector: Uint8Array,
    turnId: string | undefined,
  ): ConcurrentDetectionResult {
    if (updates.length === 0) {
      return { humanTouchedHashes: new Set(), touchedHashes: new Set() };
    }
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
    baselineSnapshot: Uint8Array | undefined,
  ): { doc: Y.Doc; vector: Uint8Array; destroy?: () => void } {
    if (!baselineSnapshot) return { doc: runtime.doc, vector: Y.encodeStateVector(runtime.doc) };
    const detectionDoc = docFromSnapshot(baselineSnapshot);
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

function intersectHashes(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((hash) => right.has(hash)).sort();
}

function mergeConcurrentDetection(
  previous: ConcurrentDetectionResult | undefined,
  incremental: ConcurrentDetectionResult,
): ConcurrentDetectionResult {
  if (!previous) return incremental;
  const human = new Set([...(previous.info?.human ?? []), ...(incremental.info?.human ?? [])]);
  const agent = new Set([...(previous.info?.agent ?? []), ...(incremental.info?.agent ?? [])]);
  const humanTouchedHashes = new Set([
    ...previous.humanTouchedHashes,
    ...incremental.humanTouchedHashes,
  ]);
  const touchedHashes = new Set([...previous.touchedHashes, ...incremental.touchedHashes]);
  if (!previous.info && !incremental.info) return { humanTouchedHashes, touchedHashes };
  return {
    humanTouchedHashes,
    touchedHashes,
    info: {
      human: [...human],
      agent: [...agent],
      renderedBlocks: {
        human: [
          ...(previous.info?.renderedBlocks?.human ?? []),
          ...(incremental.info?.renderedBlocks?.human ?? []),
        ],
        agent: [
          ...(previous.info?.renderedBlocks?.agent ?? []),
          ...(incremental.info?.renderedBlocks?.agent ?? []),
        ],
      },
      ...(previous.info?.collapsed || incremental.info?.collapsed ? { collapsed: true } : {}),
      ...((incremental.info?.reviewCommand ?? previous.info?.reviewCommand)
        ? { reviewCommand: incremental.info?.reviewCommand ?? previous.info?.reviewCommand }
        : {}),
    },
  };
}

function destructiveWriteRejection(conflictedBlockHashes: readonly string[]): InternalWriteResult {
  return status(
    "destructive_write_rejected",
    `Rejected: your edit would delete blocks the writer changed since your last read. Affected blocks: [${conflictedBlockHashes.join(", ")}]. Re-read and replan.`,
  );
}
