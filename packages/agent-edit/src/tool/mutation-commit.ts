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
import { digestRenderedContent, observationCoversRendering } from "../observation-snapshot.js";
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
import { status } from "./response-format.js";
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
  actor: MutationActor;
}

export interface ImmediateCommitInput extends LiveProjectionInput {
  runtime: MutationCommitRuntime;
}

export interface LocalMutationSyncInput {
  docId: string;
  commandName: WriteCommand["command"];
  runtime: MutationCommitRuntime;
  update: Uint8Array;
  meta: UpdateMeta;
  mutation?: JournaledUpdate["mutation"];
  afterOwnVector: Uint8Array;
  liveOrigin: ConcurrentUpdateOrigin;
  before: readonly BlockSnapshot[];
  touchedHashes: ReadonlySet<string>;
  deletedHashes: ReadonlySet<string>;
  ownTurnId?: string;
  interactionContext?: InteractionContext;
  preOwnSnapshot?: Uint8Array;
  actor: MutationActor;
}

export interface SafetyGateInput {
  docId: string;
  runtime: MutationCommitRuntime;
  afterOwnVector: Uint8Array;
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

export type SafetyGateResult =
  | { verdict: "pass"; concurrent: CapturedConcurrentDetection }
  | {
      verdict: "reject";
      reason: "observation_required" | "human_conflict";
      conflictedBlockHashes: string[];
    };

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
  preflightSafetyGate(liveDoc: Y.Doc, input: SafetyGateInput): Promise<SafetyGateResult>;
  applyCommittedUpdateWithRecheck(
    liveDoc: Y.Doc,
    input: SafetyGateInput & { update: Uint8Array; liveOrigin: ConcurrentUpdateOrigin },
    preflight?: CapturedConcurrentDetection,
  ): Promise<ApplyWithRecheckResult>;
  recheckCommittedUpdate(liveDoc: Y.Doc, input: SafetyGateInput): Promise<ApplyWithRecheckResult>;
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
    preflightSafetyGate,
    applyCommittedUpdateWithRecheck,
    recheckCommittedUpdate,
    lookupObservation,
  };

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
        const gate = await preflightSafetyGate(liveDoc, input);
        if (gate.verdict === "reject") return safetyGateRejection(input.docId, gate);
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
        // INVARIANT (LOCK-WS): immediate apply remains synchronous at this site;
        // never insert an await immediately before Y.applyUpdate.
        Y.applyUpdate(liveDoc, input.update, input.liveOrigin);
        observationCut = freezeObservationCut(beforeApplySnapshot, snapshotLive(liveDoc));
        lateSweep = destructiveReport(input, gate.concurrent, observationCut);
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
      observationCut: requiredCut(observationCut),
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
        const gate = await preflightSafetyGate(liveDoc, {
          ...input,
          ownTurnId: input.turnId,
        });
        if (gate.verdict === "reject") return safetyGateRejection(input.docId, gate);
        const journalCommit = await commitJournalBatch(journalEntries(input));
        journalCommitKind = journalCommit.journalCommitKind;
        captured = gate.concurrent;
        const beforeApplySnapshot = snapshotBlocks(toDocHandle(liveDoc), model, codec);
        // INVARIANT (LOCK-WS): immediate apply remains synchronous at this site;
        // never insert an await immediately before Y.applyUpdate.
        Y.applyUpdate(
          liveDoc,
          mergeUpdates(input.updates.map((entry) => entry.update)),
          input.liveOrigin,
        );
        observationCut = freezeObservationCut(beforeApplySnapshot, snapshotLive(liveDoc));
        lateSweep = destructiveReport(input, gate.concurrent, observationCut);
        return null;
      },
    );
    if (isInternalWriteResult(response)) return { ok: false, response, journalCommitKind };
    if (captured) applyCapturedConcurrentToRuntime(input.runtime, captured);
    return {
      ok: true,
      concurrentUpdates: [...(captured?.updates ?? [])],
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

  async function preflightSafetyGate(
    liveDoc: Y.Doc,
    input: SafetyGateInput,
  ): Promise<SafetyGateResult> {
    const concurrent = await captureConcurrentDetection(liveDoc, input);
    if (input.actor.kind === "system") return { verdict: "pass", concurrent };
    const destructiveHashes = candidateDestructiveHashes(input);
    if (
      input.actor.kind === "agent" &&
      destructiveHashes.length > 0 &&
      !hasDocumentObservation(concurrent.observationSnapshot, input.docId)
    ) {
      return {
        verdict: "reject",
        reason: "observation_required",
        conflictedBlockHashes: destructiveHashes,
      };
    }
    return { verdict: "pass", concurrent };
  }

  async function applyCommittedUpdateWithRecheck(
    liveDoc: Y.Doc,
    input: SafetyGateInput & { update: Uint8Array; liveOrigin: ConcurrentUpdateOrigin },
    preflight?: CapturedConcurrentDetection,
  ): Promise<ApplyWithRecheckResult> {
    const current = preflight
      ? await captureConcurrentDetection(liveDoc, input, preflight)
      : await captureConcurrentDetection(liveDoc, input);
    const beforeApplySnapshot = snapshotBlocks(toDocHandle(liveDoc), model, codec);
    // INVARIANT (LOCK-WS): this final in-memory snapshot recheck and Y.applyUpdate
    // are one synchronous block. Never add an await between them.
    Y.applyUpdate(liveDoc, input.update, input.liveOrigin);
    const observationCut = freezeObservationCut(beforeApplySnapshot, snapshotLive(liveDoc));
    const lateSweep = destructiveReport(input, current, observationCut);
    return {
      concurrent: current,
      observationCut,
      ...(lateSweep ? { lateSweep } : {}),
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

  function snapshotLive(doc: Y.Doc): readonly BlockSnapshot[] {
    return snapshotBlocks(toDocHandle(doc), model, codec);
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
    input: SafetyGateInput,
    previous?: CapturedConcurrentDetection,
  ): Promise<CapturedConcurrentDetection> {
    const detectionDoc = previous
      ? docFromSnapshot(previous.detectionSnapshot)
      : docFromSnapshot(input.preOwnSnapshot ?? Y.encodeStateAsUpdate(input.runtime.doc));
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

  function destructiveReport(
    input: SafetyGateInput,
    concurrent: CapturedConcurrentDetection,
    cut: AtomicObservationCut,
  ): DestructiveSweepReport | undefined {
    if (input.actor.kind !== "agent") return undefined;
    const destructive = diffSnapshots(cut.liveBefore, cut.liveAfter);
    const affected = new Set([...destructive.changed, ...destructive.deleted]);
    const agentHashes = new Set(concurrent.detection.info?.agent ?? []);
    const humanHashes = concurrent.detection.humanTouchedHashes;
    const affectedBlockHashes = cut.liveBefore
      .filter((block) => affected.has(block.hash))
      .filter((block) => humanHashes.has(block.hash) || !agentHashes.has(block.hash))
      .filter((block) => !wasObserved(concurrent.observationSnapshot, input.docId, block))
      .map((block) => block.hash)
      .sort();
    if (affectedBlockHashes.length === 0) return undefined;
    return {
      affectedBlockHashes,
      capturedDeletedBodies: captureSnapshotBodies(cut.liveBefore, affectedBlockHashes),
      sweptContent: true,
      beforeContentRef: input.interactionContext?.afterJournalId ?? null,
    };
  }

  function candidateDestructiveHashes(input: SafetyGateInput): string[] {
    const before = input.preOwnSnapshot
      ? new Set(snapshotFromUpdate(input.preOwnSnapshot).map((block) => block.hash))
      : null;
    return [
      ...new Set(
        [...input.deletedHashes, ...input.touchedHashes].filter(
          (hash) => !before || before.has(hash),
        ),
      ),
    ].sort();
  }
}

function hasDocumentObservation(snapshot: ObservationSnapshot | null, documentId: string): boolean {
  return snapshot?.entries.some((entry) => entry.documentId === documentId) ?? false;
}

function wasObserved(
  snapshot: ObservationSnapshot | null,
  documentId: string,
  block: BlockSnapshot,
): boolean {
  if (
    block.clientID === undefined ||
    block.clock === undefined ||
    block.renderedContent === undefined
  )
    return false;
  const observed = snapshot?.entries.find(
    (entry) =>
      entry.documentId === documentId &&
      entry.clientID === block.clientID &&
      entry.clock === block.clock,
  );
  return observationCoversRendering({
    observation: observed?.value ?? null,
    renderedContent: block.renderedContent,
    digestRenderedContent,
  });
}

function freezeObservationCut(
  liveBefore: readonly BlockSnapshot[],
  liveAfter: readonly BlockSnapshot[],
): AtomicObservationCut {
  return Object.freeze({
    liveBefore: Object.freeze(liveBefore.map((block) => Object.freeze({ ...block }))),
    liveAfter: Object.freeze(liveAfter.map((block) => Object.freeze({ ...block }))),
  });
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

function safetyGateRejection(
  docId: string,
  gate: Extract<SafetyGateResult, { verdict: "reject" }>,
): InternalWriteResult {
  if (gate.reason === "human_conflict") {
    return destructiveWriteRejection(gate.conflictedBlockHashes);
  }
  return status(
    "rejected_response_requires_reread",
    `This response has no sealed observation for ${docId}. Read the document in a new response before making a destructive change.`,
  );
}
