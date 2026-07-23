// Journal batch commit and live projection for mutating writes.
import * as Y from "yjs";
import { classifyDestructiveDocumentEffect } from "../apply/destructive-classification.js";
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
import { sealedWriterLineageV3, subtractLineageRanges } from "../lineage/range-set.js";
import type { DocumentCoordinator } from "../ports/document-coordinator.js";
import type { AgentEditModel } from "../ports/model.js";
import type {
  ObservationKey,
  ObservationSnapshot,
  ObservationSnapshotStore,
  ObservationValue,
} from "../ports/observation-snapshot.js";
import type { UpdateMeta } from "../ports/types.js";
import type {
  JournalBatchAppendEntry,
  JournalCommitKind,
  UpdateJournal,
} from "../ports/update-journal.js";
import { effectiveYjsUpdate } from "../yjs-update.js";
import { withLiveDocument } from "./coordinator.js";
import { type InternalWriteResult, isInternalWriteResult } from "./internal-result.js";
import type { InteractionContext, MutationActor, WriteCommand } from "./types.js";

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
  interactionContext?: InteractionContext;
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
  liveOrigin: ConcurrentUpdateOrigin;
  interactionContext?: InteractionContext;
}

export interface LiveProjectionInput extends LiveUpdateCommitInput {
  touchedHashes: ReadonlySet<string>;
  deletedHashes: ReadonlySet<string>;
  preOwnSnapshot?: Uint8Array;
  turnId?: string;
  actor: MutationActor;
}

export interface ImmediateCommitInput extends LiveProjectionInput {
  runtime: MutationCommitRuntime;
  before?: readonly BlockSnapshot[];
}

export interface LocalMutationSyncInput {
  docId: string;
  commandName: WriteCommand["command"];
  runtime: MutationCommitRuntime;
  update: Uint8Array;
  meta: UpdateMeta;
  mutation?: JournaledUpdate["mutation"];
  liveOrigin: ConcurrentUpdateOrigin;
  before: readonly BlockSnapshot[];
  touchedHashes: ReadonlySet<string>;
  deletedHashes: ReadonlySet<string>;
  ownTurnId?: string;
  interactionContext?: InteractionContext;
  preOwnSnapshot?: Uint8Array;
  actor: MutationActor;
}

export interface CommitPreflightInput {
  docId: string;
  runtime: MutationCommitRuntime;
  deletedHashes: ReadonlySet<string>;
  touchedHashes: ReadonlySet<string>;
  interactionContext?: InteractionContext;
  preOwnSnapshot?: Uint8Array;
  ownTurnId?: string;
  actor: MutationActor;
}

export interface CapturedConcurrentDetection {
  updates: readonly ConcurrentUpdate[];
  detection: ConcurrentDetectionResult;
  detectionSnapshot: Uint8Array;
  liveStateVector: Uint8Array;
  observationSnapshot: ObservationSnapshot | null;
}

export interface DestructiveSweepReport {
  affectedBlockHashes: string[];
  capturedDeletedBodies?: { hash: string; body: string }[];
  sweptContent: true;
  beforeContentRef: number | null;
}

export interface ApplyWithRecheckResult {
  concurrent: CapturedConcurrentDetection;
  observationCut?: AtomicObservationCut;
  lateSweep?: DestructiveSweepReport;
}

export interface AtomicObservationCut {
  readonly liveBefore: readonly BlockSnapshot[];
  readonly liveAfter: readonly BlockSnapshot[];
}

export type JournalBatchCommit = {
  journalCommitKind: JournalCommitKind;
};

type LiveCommitResult =
  | {
      ok: true;
      concurrentUpdates: ConcurrentUpdate[];
      summary: SyncedMutationSummary;
      journalCommitKind: JournalCommitKind;
      observationCut?: AtomicObservationCut;
      lateSweep?: DestructiveSweepReport;
    }
  | { ok: false; response: InternalWriteResult; journalCommitKind: JournalCommitKind | null };

type MutationSyncResult =
  | {
      ok: true;
      summary: SyncedMutationSummary;
      journalCommitKind: JournalCommitKind | null;
      observationCut?: AtomicObservationCut;
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
  captureCommitPreflight(
    liveDoc: Y.Doc,
    input: CommitPreflightInput,
  ): Promise<CapturedConcurrentDetection>;
  applyCommittedUpdateWithRecheck(
    liveDoc: Y.Doc,
    input: CommitPreflightInput & { update: Uint8Array; liveOrigin: ConcurrentUpdateOrigin },
    preflight?: CapturedConcurrentDetection,
  ): Promise<ApplyWithRecheckResult>;
  recheckCommittedUpdate(
    liveDoc: Y.Doc,
    input: CommitPreflightInput,
  ): Promise<ApplyWithRecheckResult>;
  lookupObservation(responseId: string, key: ObservationKey): Promise<ObservationValue | null>;
}

export function createMutationCommit(deps: {
  journal: UpdateJournal;
  coordinator: DocumentCoordinator;
  model: AgentEditModel;
  codec: AgentEditCodec;
  observationSnapshots?: ObservationSnapshotStore;
}): MutationCommit {
  const { journal, coordinator, model, codec, observationSnapshots } = deps;

  return {
    syncAfterLocalMutation,
    commitImmediate,
    commitJournalBatch,
    summarizeMutationEcho,
    detectConcurrentEdits,
    captureCommitPreflight,
    applyCommittedUpdateWithRecheck,
    recheckCommittedUpdate,
    lookupObservation,
  };

  async function recordWriterProtectionScope(
    docId: string,
    responseId: string,
    cut: AtomicObservationCut,
    concurrent: CapturedConcurrentDetection,
  ): Promise<void> {
    if (!journal.recordWriterProtectionScope) return;
    const responseCausalCutId = concurrent.observationSnapshot?.causalCuts?.find(
      (candidate) => candidate.documentId === docId,
    )?.id;
    if (!responseCausalCutId) return;
    const knownAgentLineage = concurrent.detection.lineageOrigins.filter(
      (lineage) => lineage.origin === "agent",
    );
    const ranges = subtractLineageRanges(
      cut.liveBefore.flatMap((block) => block.lineage ?? []),
      cut.liveAfter.flatMap((block) => block.lineage ?? []),
      knownAgentLineage,
    );
    await journal.recordWriterProtectionScope({
      docId,
      responseId,
      token: sealedWriterLineageV3({
        documentId: docId,
        protectedRoots: ranges,
        responseCausalCutId,
      }),
    });
  }

  async function syncAfterLocalMutation(
    input: LocalMutationSyncInput,
  ): Promise<MutationSyncResult> {
    let captured: CapturedConcurrentDetection | undefined;
    let lateSweep: DestructiveSweepReport | undefined;
    let journalCommitKind: JournalCommitKind | null = null;
    let observationCut: AtomicObservationCut | undefined;
    const response = await withLiveDocument(
      coordinator,
      input.docId,
      input.commandName,
      input.docId,
      async (liveDoc) => {
        const preflight = await captureCommitPreflight(liveDoc, input);
        const committed = await commitJournalBatch([
          {
            docId: input.docId,
            update: input.update,
            meta: input.meta,
            ...(input.mutation ? { mutation: input.mutation } : {}),
          },
        ]);
        journalCommitKind = committed.journalCommitKind;
        captured = preflight;
        const beforeApplyDoc = docFromSnapshot(Y.encodeStateAsUpdate(liveDoc));
        const beforeApplySnapshot = snapshotBlocks(toDocHandle(beforeApplyDoc), model, codec);
        // INVARIANT (LOCK-WS): immediate apply remains synchronous at this site;
        // never insert an await immediately before Y.applyUpdate.
        Y.applyUpdate(liveDoc, input.update, input.liveOrigin);
        const afterApplyDoc = docFromSnapshot(Y.encodeStateAsUpdate(liveDoc));
        observationCut = freezeObservationCut(
          beforeApplySnapshot,
          snapshotBlocks(toDocHandle(afterApplyDoc), model, codec),
        );
        try {
          lateSweep = await destructiveReport(input, preflight, beforeApplyDoc, afterApplyDoc);
        } finally {
          beforeApplyDoc.destroy();
          afterApplyDoc.destroy();
        }
        return null;
      },
    );
    if (isInternalWriteResult(response)) {
      return { ok: false, response, journalCommitKind };
    }
    const concurrent = captured
      ? applyCapturedConcurrentToRuntime(input.runtime, captured)
      : emptyConcurrentDetection();
    return {
      ok: true,
      summary: summarizeMutationEcho(input, concurrent),
      journalCommitKind,
      observationCut: requiredCut(observationCut),
      ...(lateSweep ? { lateSweep } : {}),
    };
  }

  function summarizeMutationEcho(
    input: MutationEchoInput,
    concurrent: ConcurrentDetectionResult = emptyConcurrentDetection(),
  ): SyncedMutationSummary {
    const after =
      input.afterSnapshot ?? snapshotBlocks(toDocHandle(input.runtime.doc), model, codec);
    const echo = computeEcho({
      before: input.before,
      after,
      agentTouchedHashes: input.touchedHashes,
      agentDeletedHashes: input.deletedHashes,
    });
    const pulledEcho = input.interactionContext?.attributionBaseline
      ? computeEcho({
          before: snapshotFromUpdate(input.interactionContext.attributionBaseline),
          after: input.before,
          agentTouchedHashes: input.touchedHashes,
          agentDeletedHashes: input.deletedHashes,
        })
      : [];
    return {
      echo: [...pulledEcho, ...echo],
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
    const detectionDoc = input.preOwnSnapshot
      ? docFromSnapshot(input.preOwnSnapshot)
      : input.runtime.doc;
    const detectionVector = Y.encodeStateVector(detectionDoc);
    const preOwnDoc = input.preOwnSnapshot ? docFromSnapshot(input.preOwnSnapshot) : undefined;
    try {
      const updates = await concurrentUpdatesSince(
        coordinator,
        input.docId,
        preOwnDoc ?? input.runtime.doc,
        detectionDoc,
        detectionVector,
        input.interactionContext?.afterJournalId,
        input.interactionContext?.liveJournalSeq,
        input.interactionContext?.attemptId,
      );
      return applyConcurrentOnDoc(
        detectionDoc,
        input.runtime,
        updates,
        detectionVector,
        input.ownTurnId,
      );
    } finally {
      preOwnDoc?.destroy();
      if (detectionDoc !== input.runtime.doc) detectionDoc.destroy();
    }
  }

  async function commitImmediate(input: ImmediateCommitInput): Promise<LiveCommitResult> {
    let captured: CapturedConcurrentDetection | undefined;
    let lateSweep: DestructiveSweepReport | undefined;
    let journalCommitKind: JournalCommitKind | null = null;
    let observationCut: AtomicObservationCut | undefined;
    const response = await withLiveDocument(
      coordinator,
      input.docId,
      input.commandName,
      input.docId,
      async (liveDoc) => {
        const preflight = await captureCommitPreflight(liveDoc, {
          ...input,
          ownTurnId: input.turnId,
        });
        const journalCommit = await commitJournalBatch(journalEntries(input));
        journalCommitKind = journalCommit.journalCommitKind;
        captured = preflight;
        const beforeApplyDoc = docFromSnapshot(Y.encodeStateAsUpdate(liveDoc));
        const beforeApplySnapshot = snapshotBlocks(toDocHandle(beforeApplyDoc), model, codec);
        // INVARIANT (LOCK-WS): immediate apply remains synchronous at this site;
        // never insert an await immediately before Y.applyUpdate.
        Y.applyUpdate(
          liveDoc,
          mergeUpdates(input.updates.map((entry) => entry.update)),
          input.liveOrigin,
        );
        const afterApplyDoc = docFromSnapshot(Y.encodeStateAsUpdate(liveDoc));
        observationCut = freezeObservationCut(
          beforeApplySnapshot,
          snapshotBlocks(toDocHandle(afterApplyDoc), model, codec),
        );
        try {
          lateSweep = await destructiveReport(input, preflight, beforeApplyDoc, afterApplyDoc);
        } finally {
          beforeApplyDoc.destroy();
          afterApplyDoc.destroy();
        }
        return null;
      },
    );
    if (isInternalWriteResult(response)) return { ok: false, response, journalCommitKind };
    if (captured) applyCapturedConcurrentToRuntime(input.runtime, captured);
    return {
      ok: true,
      concurrentUpdates: [...(captured?.updates ?? [])],
      summary: summarizeMutationEcho(
        {
          runtime: input.runtime,
          before:
            input.before ??
            snapshotFromUpdate(input.preOwnSnapshot ?? Y.encodeStateAsUpdate(input.runtime.doc)),
          touchedHashes: input.touchedHashes,
          deletedHashes: input.deletedHashes,
          interactionContext: input.interactionContext,
        },
        captured?.detection,
      ),
      journalCommitKind: journalCommitKind ?? "durable",
      observationCut: requiredCut(observationCut),
      ...(lateSweep ? { lateSweep } : {}),
    };
  }

  async function commitJournalBatch(
    entries: readonly JournalBatchAppendEntry[],
  ): Promise<JournalBatchCommit> {
    const results = await journal.appendBatch(entries);
    const journalCommitKind = results.some((result) => result.journalCommitKind === "staged")
      ? "staged"
      : "durable";
    return { journalCommitKind };
  }

  async function captureCommitPreflight(
    liveDoc: Y.Doc,
    input: CommitPreflightInput,
  ): Promise<CapturedConcurrentDetection> {
    return captureConcurrentDetection(liveDoc, input);
  }

  async function applyCommittedUpdateWithRecheck(
    liveDoc: Y.Doc,
    input: CommitPreflightInput & { update: Uint8Array; liveOrigin: ConcurrentUpdateOrigin },
    preflight?: CapturedConcurrentDetection,
  ): Promise<ApplyWithRecheckResult> {
    const current = preflight
      ? await captureConcurrentDetection(liveDoc, input, preflight)
      : await captureConcurrentDetection(liveDoc, input);
    const beforeApplyDoc = docFromSnapshot(Y.encodeStateAsUpdate(liveDoc));
    const beforeApplySnapshot = snapshotBlocks(toDocHandle(beforeApplyDoc), model, codec);
    // INVARIANT (LOCK-WS): this final in-memory snapshot recheck and Y.applyUpdate
    // are one synchronous block. Never add an await between them.
    Y.applyUpdate(liveDoc, input.update, input.liveOrigin);
    const afterApplyDoc = docFromSnapshot(Y.encodeStateAsUpdate(liveDoc));
    const observationCut = freezeObservationCut(
      beforeApplySnapshot,
      snapshotBlocks(toDocHandle(afterApplyDoc), model, codec),
    );
    let lateSweep: DestructiveSweepReport | undefined;
    try {
      lateSweep = await destructiveReport(input, current, beforeApplyDoc, afterApplyDoc);
    } finally {
      beforeApplyDoc.destroy();
      afterApplyDoc.destroy();
    }
    if (input.actor.kind === "agent" && input.actor.responseId) {
      await recordWriterProtectionScope(
        input.docId,
        input.actor.responseId,
        observationCut,
        current,
      );
    }
    return {
      concurrent: current,
      observationCut,
      ...(lateSweep ? { lateSweep } : {}),
    };
  }

  async function recheckCommittedUpdate(
    liveDoc: Y.Doc,
    input: CommitPreflightInput,
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

  async function lookupObservation(
    responseId: string,
    key: ObservationKey,
  ): Promise<ObservationValue | null> {
    const snapshot = await observationSnapshots?.load(responseId);
    if (!snapshot) return null;
    return (
      snapshot.entries.find(
        (entry) =>
          entry.documentId === key.documentId &&
          entry.clientID === key.clientID &&
          entry.clock === key.clock,
      )?.value ?? null
    );
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

  async function captureConcurrentDetection(
    liveDoc: Y.Doc,
    input: CommitPreflightInput,
    previous?: CapturedConcurrentDetection,
  ): Promise<CapturedConcurrentDetection> {
    const detectionDoc = previous
      ? docFromSnapshot(previous.detectionSnapshot)
      : docFromSnapshot(
          input.interactionContext?.attributionBaseline ??
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
        input.interactionContext?.liveJournalSeq,
        input.interactionContext?.attemptId,
      );
      const incremental = applyConcurrentUpdates(
        toDocHandle(detectionDoc),
        model,
        codec,
        updates,
        ownUpdateOrigin(input.actor),
      );
      return {
        updates: [...(previous?.updates ?? []), ...updates],
        detection: mergeConcurrentDetection(previous?.detection, incremental),
        detectionSnapshot: Y.encodeStateAsUpdate(detectionDoc),
        liveStateVector: Y.encodeStateVector(liveDoc),
        observationSnapshot:
          previous?.observationSnapshot ??
          (input.actor.kind === "agent" && input.actor.responseId
            ? ((await observationSnapshots?.load(input.actor.responseId)) ?? null)
            : null),
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

  async function destructiveReport(
    input: CommitPreflightInput,
    concurrent: CapturedConcurrentDetection,
    before: Y.Doc,
    afterCandidate: Y.Doc,
  ): Promise<DestructiveSweepReport | undefined> {
    if (input.actor.kind !== "agent") return undefined;
    const affected = await classifyDestructiveDocumentEffect(
      { journal, model, codec },
      {
        documentId: input.docId,
        before: toDocHandle(before),
        afterCandidate: toDocHandle(afterCandidate),
        observationSnapshot: concurrent.observationSnapshot,
        observedBlocks: concurrent.detection.baselineBlocks,
        attributedLineage: concurrent.detection.lineageOrigins,
      },
    );
    const affectedBlockHashes = affected.map((block) => block.hash).sort();
    if (affectedBlockHashes.length === 0) return undefined;
    return {
      affectedBlockHashes,
      capturedDeletedBodies: captureSnapshotBodies(
        snapshotBlocks(toDocHandle(before), model, codec),
        affectedBlockHashes,
      ),
      sweptContent: true,
      beforeContentRef: input.interactionContext?.afterJournalId ?? null,
    };
  }
}

function freezeObservationCut(
  liveBefore: readonly BlockSnapshot[],
  liveAfter: readonly BlockSnapshot[],
): AtomicObservationCut {
  return Object.freeze({
    liveBefore: freezeBlockSnapshots(liveBefore),
    liveAfter: freezeBlockSnapshots(liveAfter),
  });
}

function freezeBlockSnapshots(blocks: readonly BlockSnapshot[]): readonly BlockSnapshot[] {
  return Object.freeze(
    blocks.map((block) =>
      Object.freeze({
        ...block,
        lineage: Object.freeze(
          (block.lineage ?? []).map((lineage) => Object.freeze({ ...lineage })),
        ),
      }),
    ),
  );
}

function requiredCut(cut: AtomicObservationCut | undefined): AtomicObservationCut {
  if (!cut) throw new Error("Mutation completed without an atomic observation cut");
  return cut;
}

function ownUpdateOrigin(actor: MutationActor): ConcurrentUpdateOrigin | undefined {
  if (actor.kind === "agent") return agentUpdateOrigin(actor.turnId);
  if (actor.kind === "human") return { type: "human", userId: actor.userId };
  return undefined;
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
  liveJournalSeq?: number,
  attemptId?: string,
): Promise<ConcurrentUpdate[]> {
  if (coordinator.concurrentUpdatesSince) {
    return coordinator.concurrentUpdatesSince({
      docId,
      doc,
      baselineDoc,
      sinceStateVector,
      afterJournalId,
      liveJournalSeq,
      attemptId,
    });
  }
  const update = Y.encodeStateAsUpdate(doc, sinceStateVector);
  const probe = baselineDoc ?? new Y.Doc({ gc: false });
  try {
    return effectiveYjsUpdate(probe, update)
      ? [{ update, origin: { type: "human", userId: "unknown" } }]
      : [];
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
  const lineageOrigins = [...previous.lineageOrigins, ...incremental.lineageOrigins];
  if (!previous.info && !incremental.info)
    return {
      humanTouchedHashes,
      touchedHashes,
      baselineBlocks: previous.baselineBlocks,
      lineageOrigins,
    };
  return {
    humanTouchedHashes,
    touchedHashes,
    baselineBlocks: previous.baselineBlocks,
    lineageOrigins,
    info: {
      human: [...human],
      agent: [...agent],
      runs: [...(previous.info?.runs ?? []), ...(incremental.info?.runs ?? [])],
      ...(previous.info?.syncOverflow || incremental.info?.syncOverflow
        ? { syncOverflow: true }
        : {}),
    },
  };
}

function emptyConcurrentDetection(): ConcurrentDetectionResult {
  return {
    humanTouchedHashes: new Set(),
    touchedHashes: new Set(),
    baselineBlocks: [],
    lineageOrigins: [],
  };
}
