/** Hocuspocus load/store persistence hooks and queue metrics for collab documents. */
import type { Hocuspocus } from "@hocuspocus/server";
import type { UpdateJournal, UpdateMeta } from "@meridian/agent-edit";
import { branchRoomName } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { RESERVED_CLIENT_ID_MAX } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { type EventSink, emitEvent } from "../observability/index.js";
import { loadDocumentState } from "./adapters/document-loader.js";
import type {
  BranchCoordinator,
  BranchSnapshot,
  BranchStore,
} from "./domain/branch-coordinator.js";
import { createDocumentContainment } from "./domain/document-containment.js";
import {
  admitWriterUpdate,
  ReservedWriterClientIdError,
} from "./domain/document-mutation-policy.js";
import type { OfflineReconciliation } from "./domain/offline-reconciliation.js";
import type { WriterIngressBarrier } from "./domain/ports/writer-ingress-barrier.js";
import { ReservedNamespaceAdmissionError } from "./domain/provenance.js";
import type { CollabPersistenceMetrics, CollabTransport, UpdateOrigin } from "./index.js";

type PendingAppend = {
  documentId: string;
  startedAt: number;
  promise: Promise<void>;
};

type HocuspocusPersistenceDeps = {
  journal: UpdateJournal;
  branchStore?: BranchStore;
  branchCoordinator?: BranchCoordinator;
  hocuspocus(): Hocuspocus | null;
  eventSink?: EventSink;
  metaForOrigin(origin: UpdateOrigin): UpdateMeta;
  latestUpdateSeq(documentId: string): Promise<number>;
  readAuthorityHeadGeneration?(documentId: DocumentId): Promise<bigint>;
  emitAgentEditInvariantViolation(payload: Record<string, unknown>): void;
  onLiveUpdatePersisted?(documentId: DocumentId): void;
  offlineReconciliation?: OfflineReconciliation;
};

export type HocuspocusPersistenceService = Pick<
  CollabTransport,
  | "resolveBranchHocuspocusRoom"
  | "loadHocuspocusDocument"
  | "loadHocuspocusBranchState"
  | "admitLiveWriterUpdate"
  | "currentLiveGeneration"
  | "admitBranchWriterUpdate"
  | "persistConnectionUpdate"
  | "storeHocuspocusDocument"
  | "storeHocuspocusBranch"
  | "drainHocuspocusPersistence"
  | "drainHocuspocusBranchPersistence"
  | "closeHocuspocusBranchRoom"
  | "rejectStaleBranchSyncStep1"
  | "getPersistenceQueueMetrics"
> & {
  writerIngressBarrier: WriterIngressBarrier;
  disconnectLiveGeneration(documentId: DocumentId, generation: bigint): Promise<void>;
};

export function createHocuspocusPersistenceService(
  deps: HocuspocusPersistenceDeps,
): HocuspocusPersistenceService {
  const pendingAppends = new Map<number, PendingAppend>();
  const droppedByDocument = new Map<string, number>();
  const unsafeCheckpointDocuments = new Map<string, number>();
  const liveAppendTails = new Map<string, Promise<void>>();
  const ingressGenerations = new Map<string, number>();
  const admittedByDocument = new Map<string, Map<number, Promise<unknown>>>();
  const retiredStateVectors = new Map<string, Uint8Array>();
  const retiredLiveDocuments = new WeakSet<Y.Doc>();
  const liveGenerations = new Map<string, bigint>();
  const documentContainment = createDocumentContainment();
  let nextPendingId = 1;

  const writerIngressBarrier: WriterIngressBarrier = {
    async drain(documentId) {
      const generation = ingressGenerations.get(documentId) ?? 0;
      const admitted = admittedByDocument.get(documentId);
      if (admitted) {
        await Promise.all(
          [...admitted].flatMap(([admissionGeneration, promise]) =>
            admissionGeneration <= generation ? [promise] : [],
          ),
        );
      }
      return generation;
    },
    isGenerationCurrent(documentId, generation) {
      return (ingressGenerations.get(documentId) ?? 0) === generation;
    },
  };

  async function drainPending(documentId?: string): Promise<void> {
    while (true) {
      const pending = [...pendingAppends.values()].filter(
        (entry) =>
          !documentId ||
          entry.documentId === documentId ||
          (documentId.startsWith("branch:") && entry.documentId.startsWith(`${documentId}:gen:`)),
      );
      if (pending.length === 0) return;
      await Promise.allSettled(pending.map((entry) => entry.promise));
    }
  }

  function trackAppend(documentId: string, promise: Promise<unknown>): void {
    const id = nextPendingId++;
    const tracked = promise
      .then(() => undefined)
      .catch((cause) => {
        recordDroppedConnectionUpdate(documentId);
        emitPersistenceAppendFailure(documentId, cause);
      })
      .finally(() => {
        pendingAppends.delete(id);
      });
    pendingAppends.set(id, { documentId, startedAt: Date.now(), promise: tracked });
  }

  function enqueueLiveAppend(documentId: string, operation: () => Promise<void>): void {
    const previous = liveAppendTails.get(documentId) ?? Promise.resolve();
    const current = previous.then(operation);
    const settled = current.catch(() => undefined);
    liveAppendTails.set(documentId, settled);
    void settled.finally(() => {
      if (liveAppendTails.get(documentId) === settled) liveAppendTails.delete(documentId);
    });
    trackAppend(documentId, current);
  }

  function rejectReservedClientIdUpdate(input: {
    documentId: DocumentId;
    origin: UpdateOrigin;
    reservedClientId: number;
  }): void {
    unsafeCheckpointDocuments.set(input.documentId, input.reservedClientId);
    recordDroppedConnectionUpdate(input.documentId);
    deps.emitAgentEditInvariantViolation({
      message: `Rejected connection update for document ${input.documentId}: Yjs clientID ${input.reservedClientId} is in the reserved server-authored band [0, ${RESERVED_CLIENT_ID_MAX}].`,
      documentId: input.documentId,
      originType: input.origin.type,
      reservedClientId: input.reservedClientId,
      reservedClientIdMax: RESERVED_CLIENT_ID_MAX,
    });
  }

  function recordDroppedConnectionUpdate(documentId: string): void {
    droppedByDocument.set(documentId, (droppedByDocument.get(documentId) ?? 0) + 1);
  }

  function emitPersistenceAppendFailure(documentId: string, cause: unknown): void {
    if (!deps.eventSink) return;
    emitEvent(deps.eventSink, {
      level: "error",
      source: "collab.hocuspocus",
      name: "persistence_append.failed",
      payload: {
        documentId,
        error: cause instanceof Error ? cause.message : String(cause),
      },
    });
  }

  function emitOfflineReconciliationFailure(documentId: string, cause: unknown): void {
    if (!deps.eventSink) return;
    emitEvent(deps.eventSink, {
      level: "error",
      source: "collab.hocuspocus",
      name: "offline_reconciliation.failed_after_durability",
      payload: {
        documentId,
        error: cause instanceof Error ? cause.message : String(cause),
      },
    });
  }

  function emitOfflineReconciliationDegraded(documentId: string): void {
    if (!deps.eventSink) return;
    emitEvent(deps.eventSink, {
      level: "warn",
      source: "collab.hocuspocus",
      name: "offline_reconciliation.evidence_degraded",
      payload: { documentId },
    });
  }

  function latestMetrics(): CollabPersistenceMetrics {
    const byDocument = new Map<
      string,
      { depth: number; oldestStartedAt: number; dropped: number }
    >();
    for (const entry of pendingAppends.values()) {
      const current = byDocument.get(entry.documentId) ?? {
        depth: 0,
        oldestStartedAt: entry.startedAt,
        dropped: droppedByDocument.get(entry.documentId) ?? 0,
      };
      current.depth += 1;
      current.oldestStartedAt = Math.min(current.oldestStartedAt, entry.startedAt);
      byDocument.set(entry.documentId, current);
    }
    for (const [documentId, dropped] of droppedByDocument) {
      if (!byDocument.has(documentId) && dropped > 0) {
        byDocument.set(documentId, { depth: 0, oldestStartedAt: Date.now(), dropped });
      }
    }
    const hocuspocus = deps.hocuspocus();
    return {
      queues: [...byDocument.entries()].map(([documentId, queue]) => ({
        documentId,
        depth: queue.depth,
        oldestAgeMs: queue.depth === 0 ? 0 : Date.now() - queue.oldestStartedAt,
        dropped: queue.dropped,
      })),
      liveDocumentCount: hocuspocus?.getDocumentsCount() ?? hocuspocus?.documents.size ?? 0,
      openConnectionCount: hocuspocus?.getConnectionsCount() ?? 0,
    };
  }

  function requireBranchStore(): BranchStore {
    if (!deps.branchStore) throw new Error("Branch Hocuspocus rooms require a branch store");
    return deps.branchStore;
  }

  function requireBranchCoordinator(): BranchCoordinator {
    if (!deps.branchCoordinator) {
      throw new Error("Branch Hocuspocus rooms require a branch coordinator");
    }
    return deps.branchCoordinator;
  }

  return {
    writerIngressBarrier,
    async currentLiveGeneration(documentId) {
      const generation =
        liveGenerations.get(documentId) ??
        (await deps.readAuthorityHeadGeneration?.(documentId)) ??
        1n;
      liveGenerations.set(documentId, generation);
      return generation;
    },

    async resolveBranchHocuspocusRoom(branchId, generation) {
      const branch = await requireBranchStore().getBranch(branchId);
      if (
        branch?.status !== "active" ||
        branch.kind !== "work_draft" ||
        branch.generation !== generation
      )
        return null;
      return {
        branchId: branch.branchId,
        documentId: branch.documentId,
        generation: branch.generation,
        status: branch.status,
      };
    },

    async loadHocuspocusDocument(documentId) {
      unsafeCheckpointDocuments.delete(documentId);
      return (await loadDocumentState(deps.journal, documentId)) ?? undefined;
    },

    async loadHocuspocusBranchState(branchId, generation) {
      const branch = await requireBranchStore().getBranch(branchId);
      if (
        branch?.status !== "active" ||
        branch.kind !== "work_draft" ||
        branch.generation !== generation
      )
        return undefined;
      return requireBranchCoordinator().readBranch(branchId, async (doc, snapshot) => ({
        state: Y.encodeStateAsUpdate(doc),
        generation: snapshot.generation,
      }));
    },

    async admitLiveWriterUpdate(input) {
      const trackedGeneration = liveGenerations.get(input.documentId);
      const currentGeneration =
        trackedGeneration ??
        (deps.readAuthorityHeadGeneration
          ? await deps.readAuthorityHeadGeneration(input.documentId)
          : 1n);
      liveGenerations.set(input.documentId, currentGeneration);
      const liveDocument = deps.hocuspocus()?.documents.get(input.documentId);
      const retiredStateVector = retiredStateVectors.get(input.documentId);
      try {
        const admission = await admitWriterUpdate({
          targetDocument: input.document,
          update: input.update,
          validateTarget() {
            if (currentGeneration !== input.expectedGeneration) {
              recordDroppedConnectionUpdate(input.documentId);
              throw new Error("stale-durable-authority-generation");
            }
            if (!liveDocument || liveDocument !== input.document) {
              throw new Error("live-document-room-mismatch");
            }
            if (
              retiredStateVector &&
              replaysRetiredGeneration(input.update, liveDocument, retiredStateVector)
            ) {
              recordDroppedConnectionUpdate(input.documentId);
              throw new Error("retired-durable-authority-generation");
            }
          },
          // Reconnects replay cached state and delete sets that Yjs would discard
          // on apply; admitting them wastes storage and pollutes safety signals.
          isContained: () => documentContainment.contains(input.document, input.update),
          async append() {
            const generation = (ingressGenerations.get(input.documentId) ?? 0) + 1;
            ingressGenerations.set(input.documentId, generation);
            const admitted = admittedByDocument.get(input.documentId) ?? new Map();
            admittedByDocument.set(input.documentId, admitted);
            const append = deps.journal.appendWriterUpdate
              ? deps.journal.appendWriterUpdate(
                  input.documentId,
                  input.update,
                  deps.metaForOrigin(input.origin),
                )
              : deps.journal
                  .append(input.documentId, input.update, deps.metaForOrigin(input.origin))
                  .then((seq) => ({ seq, joinedSettlement: false }));
            const tracked = append.catch((cause) => {
              recordDroppedConnectionUpdate(input.documentId);
              emitPersistenceAppendFailure(input.documentId, cause);
              throw cause;
            });
            admitted.set(generation, tracked);
            try {
              return await tracked;
            } finally {
              admitted.delete(generation);
              if (admitted.size === 0) admittedByDocument.delete(input.documentId);
            }
          },
        });
        if (!admission.admitted) return { admitted: false, joinedSettlement: false };
        deps.onLiveUpdatePersisted?.(input.documentId);
        return {
          admitted: true,
          joinedSettlement: admission.value.joinedSettlement,
        };
      } catch (cause) {
        if (cause instanceof ReservedWriterClientIdError) {
          rejectReservedClientIdUpdate({ ...input, reservedClientId: cause.clientId });
          throw new Error("reserved-writer-client-id");
        }
        throw cause;
      }
    },

    persistConnectionUpdate(input) {
      // The durability boundary is the awaited pre-apply admission hook. This queue
      // retains only post-apply reconciliation work and may lag acknowledgements.
      if (input.origin.type !== "user" || !input.reconcileOffline) return;
      const convergedState = Y.encodeStateAsUpdate(input.document);
      enqueueLiveAppend(input.documentId, async () => {
        try {
          const result = await deps.offlineReconciliation?.reconcile({
            documentId: input.documentId,
            incomingUpdate: input.update,
            convergedState,
          });
          if (result?.degraded) emitOfflineReconciliationDegraded(input.documentId);
        } catch (cause) {
          emitOfflineReconciliationFailure(input.documentId, cause);
        }
      });
    },

    admitBranchWriterUpdate(input) {
      const queueKey = branchRoomName(input.branchId, input.expectedGeneration);
      const admission = (async () => {
        try {
          await requireBranchCoordinator().commitWriterUpdate({
            branchId: input.branchId,
            expectedGeneration: input.expectedGeneration,
            updateData: input.update,
            actorUserId: input.origin.type === "user" ? input.origin.userId : undefined,
            roomDocument: input.document,
          });
        } catch (cause) {
          if (
            cause instanceof ReservedNamespaceAdmissionError ||
            cause instanceof ReservedWriterClientIdError
          ) {
            deps.emitAgentEditInvariantViolation({
              message: `Rejected client-authored provenance update for branch ${input.branchId}.`,
              branchId: input.branchId,
              originType: input.origin.type,
            });
          }
          throw cause;
        }
      })();
      // Register before validation's first await so shutdown cannot miss an
      // admission that Hocuspocus is already processing.
      trackAppend(queueKey, admission);
      return admission;
    },

    async storeHocuspocusDocument(documentId, document) {
      if (retiredLiveDocuments.has(document)) return;
      await drainPending(documentId);
      const reservedClientId = unsafeCheckpointDocuments.get(documentId);
      if (reservedClientId !== undefined) {
        deps.emitAgentEditInvariantViolation({
          message: `Skipped Hocuspocus checkpoint for document ${documentId} because a rejected connection update with reserved Yjs clientID ${reservedClientId} may still be present in the live Y.Doc. The reserved band is [0, ${RESERVED_CLIENT_ID_MAX}].`,
          documentId,
          reservedClientId,
          reservedClientIdMax: RESERVED_CLIENT_ID_MAX,
        });
        return;
      }
      const upToSeq = await deps.latestUpdateSeq(documentId);
      // upToSeq must be ≤ the updates reflected in state; appends after this
      // point are intentionally replayed when the document reloads.
      await deps.journal.checkpoint(documentId, Y.encodeStateAsUpdate(document), upToSeq);
    },

    async storeHocuspocusBranch(branchId, _document) {
      await drainPending(`branch:${branchId}`);
      // Every branch mutation is durable before it reaches a Hocuspocus room.
      // Re-checkpointing here can inherit the publisher's async lock context
      // and re-enter the branch critical section.
    },

    drainHocuspocusPersistence() {
      return drainPending();
    },

    drainHocuspocusBranchPersistence(branchId) {
      return drainPending(`branch:${branchId}`);
    },

    closeHocuspocusBranchRoom(branchId) {
      // Narrow ops/test affordance kept for the durable shadow probe fixture T6;
      // production reset paths use the branch coordinator reset callback.
      const hocuspocus = deps.hocuspocus();
      if (!hocuspocus) return;
      const roomPrefix = `branch:${branchId}:gen:`;
      for (const roomName of [...hocuspocus.documents.keys()].filter((name) =>
        name.startsWith(roomPrefix),
      )) {
        hocuspocus.closeConnections(roomName);
      }
    },

    async disconnectLiveGeneration(documentId, _generation) {
      liveGenerations.set(documentId, _generation + 1n);
      const hocuspocus = deps.hocuspocus();
      const document = hocuspocus?.documents.get(documentId);
      if (!hocuspocus || !document) return;
      retiredStateVectors.set(documentId, Y.encodeStateVector(document));
      retiredLiveDocuments.add(document);
      hocuspocus.closeConnections(documentId);
      hocuspocus.documents.delete(documentId);
    },

    async rejectStaleBranchSyncStep1(input) {
      const branch = await requireBranchStore().getBranch(input.branchId);
      if (
        branch?.status !== "active" ||
        branch.kind !== "work_draft" ||
        branch.generation !== input.generation ||
        !branchSyncStep1IsStale(input.clientStateVector, branch)
      ) {
        return false;
      }
      recordDroppedConnectionUpdate(branchRoomName(input.branchId, input.generation));
      if (deps.eventSink) {
        emitEvent(deps.eventSink, {
          level: "warn",
          source: "collab.hocuspocus",
          name: "branch_sync_step1.fenced",
          payload: { branchId: input.branchId, generation: input.generation },
        });
      }
      return true;
    },

    getPersistenceQueueMetrics() {
      return latestMetrics();
    },
  };
}

function branchSyncStep1IsStale(clientStateVector: Uint8Array, branch: BranchSnapshot): boolean {
  if (!branch.discardedStateVector) return false;
  const clientClocks = Y.decodeStateVector(clientStateVector);
  const currentClocks = Y.decodeStateVector(branch.stateVector);
  const discardedClocks = Y.decodeStateVector(branch.discardedStateVector);
  for (const [client, clientClock] of clientClocks) {
    const currentClock = currentClocks.get(client) ?? 0;
    if (clientClock <= currentClock) continue;
    const discardedClock = discardedClocks.get(client) ?? 0;
    if (Math.min(clientClock, discardedClock) > currentClock) return true;
  }
  return false;
}

function replaysRetiredGeneration(
  update: Uint8Array,
  current: Y.Doc,
  retiredStateVector: Uint8Array,
): boolean {
  const currentClocks = Y.decodeStateVector(Y.encodeStateVector(current));
  const retiredClocks = Y.decodeStateVector(retiredStateVector);
  const decoded = Y.decodeUpdate(update);
  if (
    decoded.structs.some((struct) => {
      const end = struct.id.clock + struct.length;
      const currentClock = currentClocks.get(struct.id.client) ?? 0;
      const retiredClock = retiredClocks.get(struct.id.client) ?? 0;
      return end > currentClock && struct.id.clock < retiredClock;
    })
  )
    return true;
  for (const [client, ranges] of decoded.ds.clients) {
    const retainedClock = Math.min(currentClocks.get(client) ?? 0, retiredClocks.get(client) ?? 0);
    if (ranges.some(({ clock, len }) => clock < retainedClock && clock + len > 0)) return true;
  }
  return false;
}
