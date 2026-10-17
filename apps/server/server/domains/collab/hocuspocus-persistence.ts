/** Hocuspocus load/store persistence hooks and queue metrics for collab documents. */
import type { Hocuspocus } from "@hocuspocus/server";
import type { UpdateMeta } from "@meridian/agent-edit/integration";
import { branchRoomName } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { RESERVED_CLIENT_ID_MAX } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { type EventSink, emitEvent, unknownToEventPayload } from "../observability/index.js";
import { type DetachedWorkTracker, processDetachedWork } from "../runtime/detached-work.js";
import { loadDocumentState } from "./adapters/document-loader.js";
import type { CollabPersistenceMetrics, CollabTransport, UpdateOrigin } from "./contracts.js";
import type { BranchCoordinator } from "./domain/branch-coordinator.js";
import type { BranchStore } from "./domain/branch-store.js";
import { createDocumentContainment } from "./domain/document-containment.js";
import {
  documentAuthority,
  isDocumentHandleRetired,
  RetiredDocumentHandleError,
  retireDocumentHandle,
} from "./domain/document-handle.js";
import {
  admitWriterUpdate,
  ReservedWriterClientIdError,
} from "./domain/document-mutation-policy.js";
import type { OfflineReconciliation } from "./domain/offline-reconciliation.js";
import type {
  CheckpointAuthority,
  CheckpointJournal,
} from "./domain/ports/checkpoint-authority.js";
import type { WriterIngressBarrier } from "./domain/ports/writer-ingress-barrier.js";
import { ReservedNamespaceAdmissionError } from "./domain/provenance.js";
import { closeRoom, whenRoomRegistered } from "./hocuspocus-rooms.js";

type PendingAppend = {
  documentId: string;
  startedAt: number;
  promise: Promise<void>;
};

type PendingCheckpoint = {
  document: Y.Doc;
  authority: CheckpointAuthority;
};

type CheckpointSlot = {
  next?: PendingCheckpoint;
  running: Promise<void>;
};

type HocuspocusPersistenceDeps = {
  journal: CheckpointJournal;
  backgroundTasks?: DetachedWorkTracker;
  branchStore?: BranchStore;
  branchCoordinator?: BranchCoordinator;
  hocuspocus(): Hocuspocus | null;
  eventSink?: EventSink;
  metaForOrigin(origin: UpdateOrigin): UpdateMeta;
  /**
   * Runs `callback` once the caller's ambient DB transaction commits, outside
   * it, and drops it on rollback; with no ambient transaction it runs now.
   * Defaults to running now, for adapters without transactions.
   */
  afterCallerCommit?(callback: () => void): void;
  readAuthorityHeadGeneration?(documentId: DocumentId): Promise<bigint>;
  emitAgentEditInvariantViolation(payload: Record<string, unknown>): void;
  onLiveUpdatePersisted?(documentId: DocumentId): void;
  /** A writer's update to a draft branch is durable (the draft's own links register, §10.7). */
  onBranchWriterUpdateAdmitted?(branchId: string): void;
  offlineReconciliation?: OfflineReconciliation;
};

export type HocuspocusPersistenceService = Pick<
  CollabTransport,
  | "resolveBranchHocuspocusRoom"
  | "loadHocuspocusDocument"
  | "loadHocuspocusBranchState"
  | "admitLiveWriterUpdate"
  | "currentLiveGeneration"
  | "validateHocuspocusDocument"
  | "admitBranchWriterUpdate"
  | "persistConnectionUpdate"
  | "storeHocuspocusDocument"
  | "storeHocuspocusBranch"
  | "drainHocuspocusPersistence"
  | "drainHocuspocusBranchPersistence"
  | "closeHocuspocusBranchRoom"
  | "rejectStaleBranchSyncStep1"
  | "enrollHocuspocusBranchRoom"
  | "getPersistenceQueueMetrics"
> & {
  writerIngressBarrier: WriterIngressBarrier;
  disconnectLiveGeneration(documentId: DocumentId, generation: bigint): Promise<void>;
};

export function createHocuspocusPersistenceService(
  deps: HocuspocusPersistenceDeps,
): HocuspocusPersistenceService {
  const backgroundTasks = deps.backgroundTasks ?? processDetachedWork;
  const pendingAppends = new Map<number, PendingAppend>();
  const droppedByDocument = new Map<string, number>();
  const unsafeCheckpointDocuments = new Map<string, number>();
  const liveAppendTails = new Map<string, Promise<void>>();
  const ingressGenerations = new Map<string, number>();
  const admittedByDocument = new Map<string, Map<number, Promise<unknown>>>();
  // A reconnected client has current transport authority but can replay cached
  // pre-restore structs/deletes. Handle fencing cannot identify that byte history.
  const retiredStateVectors = new Map<string, Uint8Array>();
  const checkpointSlots = new Map<string, CheckpointSlot>();
  const afterCallerCommit = deps.afterCallerCommit ?? ((callback: () => void) => callback());
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
      correlation: { documentId },
      payload: unknownToEventPayload(cause),
    });
  }

  function emitCheckpointFailure(documentId: string, cause: unknown): void {
    if (!deps.eventSink) return;
    emitEvent(deps.eventSink, {
      level: "error",
      source: "collab.hocuspocus",
      name: "checkpoint.failed",
      correlation: { documentId },
      payload: unknownToEventPayload(cause),
    });
  }

  /**
   * Writes live checkpoints in the background, one at a time per document; a
   * request that arrives while one is writing replaces any queued one.
   */
  function startCheckpoint(documentId: string, pending: PendingCheckpoint): void {
    const slot = checkpointSlots.get(documentId);
    if (slot) {
      slot.next = pending;
      return;
    }
    const created: CheckpointSlot = { next: pending, running: Promise.resolve() };
    checkpointSlots.set(documentId, created);
    created.running = backgroundTasks.track(
      (async () => {
        while (created.next) {
          const { document, authority } = created.next;
          created.next = undefined;
          // A retired room's state belongs to an authority generation that has
          // since been replaced.
          if (isDocumentHandleRetired(document)) {
            continue;
          }
          try {
            const cut = await deps.journal.captureCheckpoint(documentId, authority);
            if (cut) {
              const state = await cut.materializeState();
              await deps.journal.storeCheckpoint(cut);
              if (deps.eventSink)
                emitEvent(deps.eventSink, {
                  level: "debug",
                  source: "collab.hocuspocus",
                  name: "checkpoint.clients",
                  payload: {
                    documentId,
                    clientCount: Y.decodeStateVector(Y.encodeStateVectorFromUpdate(state)).size,
                  },
                });
            }
          } catch (cause) {
            emitCheckpointFailure(documentId, cause);
          }
        }
      })().finally(() => {
        checkpointSlots.delete(documentId);
      }),
      "Hocuspocus checkpoint",
    );
  }

  async function drainCheckpoints(): Promise<void> {
    while (checkpointSlots.size > 0) {
      await Promise.allSettled([...checkpointSlots.values()].map((slot) => slot.running));
    }
  }

  function emitOfflineReconciliationFailure(documentId: string, cause: unknown): void {
    if (!deps.eventSink) return;
    emitEvent(deps.eventSink, {
      level: "error",
      source: "collab.hocuspocus",
      name: "offline_reconciliation.failed_after_durability",
      correlation: { documentId },
      payload: unknownToEventPayload(cause),
    });
  }

  function emitOfflineReconciliationDegraded(documentId: string): void {
    if (!deps.eventSink) return;
    emitEvent(deps.eventSink, {
      level: "warn",
      source: "collab.hocuspocus",
      name: "offline_reconciliation.evidence_degraded",
      correlation: { documentId },
      payload: {},
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

  function retireRoom(documentId: DocumentId, document: Y.Doc): void {
    retireDocumentHandle(document);
    const hp = deps.hocuspocus();
    if (hp?.documents.get(documentId) !== document) return;
    hp.closeConnections(documentId);
    hp.documents.delete(documentId);
  }

  async function validateHocuspocusDocument(
    documentId: DocumentId,
    document: Y.Doc,
  ): Promise<void> {
    try {
      const authority = documentAuthority(document);
      const generation = await deps.readAuthorityHeadGeneration?.(documentId);
      if (
        isDocumentHandleRetired(document) ||
        (generation !== undefined && authority.generation !== generation)
      ) {
        throw new RetiredDocumentHandleError();
      }
    } catch (cause) {
      if (cause instanceof RetiredDocumentHandleError) {
        retireRoom(documentId, document);
      }
      throw cause;
    }
  }

  return {
    writerIngressBarrier,
    validateHocuspocusDocument,
    async currentLiveGeneration(documentId) {
      return (await deps.readAuthorityHeadGeneration?.(documentId)) ?? 1n;
    },

    async resolveBranchHocuspocusRoom(branchId, generation) {
      const branch = await requireBranchStore().getBranch(branchId);
      if (
        branch?.status !== "active" ||
        branch.kind !== "work_draft" ||
        !branch.workId ||
        branch.generation !== generation
      )
        return null;
      return {
        branchId: branch.branchId,
        documentId: branch.documentId,
        workId: branch.workId,
        generation: branch.generation,
        schemaVersion: branch.schemaVersion,
        status: branch.status,
      };
    },

    async loadHocuspocusDocument(documentId, document) {
      unsafeCheckpointDocuments.delete(documentId);
      if (!document) return (await loadDocumentState(deps.journal, documentId)) ?? undefined;
      try {
        const state = await loadDocumentState(deps.journal, documentId, document);
        await validateHocuspocusDocument(documentId, document);
        return state ?? undefined;
      } catch (cause) {
        if (cause instanceof RetiredDocumentHandleError) retireRoom(documentId, document);
        throw cause;
      }
    },

    async loadHocuspocusBranchState(branchId, generation) {
      const branch = await requireBranchStore().getBranch(branchId);
      if (
        branch?.status !== "active" ||
        branch.kind !== "work_draft" ||
        branch.generation !== generation
      )
        return undefined;
      // The read can land after a reset: the room loads only its own generation.
      return requireBranchCoordinator().readBranch(branchId, async (doc, snapshot) =>
        snapshot.status === "active" && snapshot.generation === generation
          ? { state: Y.encodeStateAsUpdate(doc), generation }
          : undefined,
      );
    },

    enrollHocuspocusBranchRoom({ branchId, generation, document }) {
      const hocuspocus = deps.hocuspocus();
      if (!hocuspocus) return;
      const enrollment = (async () => {
        // The load read the branch before its room became a delivery recipient: whatever
        // committed in between, a transition or a reset, reached no room.
        if (!(await whenRoomRegistered(hocuspocus, document))) return;
        const base = await requireBranchCoordinator().reconcileRegisteredRoom({
          branchId,
          generation,
          room: document,
          trigger: "enrollment",
        });
        if (!base) closeRoom(hocuspocus, document);
      })().catch((cause: unknown) => {
        if (!deps.eventSink) return;
        emitEvent(deps.eventSink, {
          level: "error",
          source: "collab.hocuspocus",
          name: "branch_room_enrollment.failed",
          correlation: { branchId, branchGeneration: generation },
          payload: unknownToEventPayload(cause),
        });
      });
      // A store of this room, and a drain of this branch, wait the enrollment out.
      trackAppend(branchRoomName(branchId, generation), enrollment);
    },

    async admitLiveWriterUpdate(input) {
      const authority = documentAuthority(input.document);
      const liveDocument = deps.hocuspocus()?.documents.get(input.documentId);
      const retiredStateVector = retiredStateVectors.get(input.documentId);
      try {
        const admission = await admitWriterUpdate({
          targetDocument: input.document,
          update: input.update,
          validateTarget() {
            if (authority.generation !== input.expectedGeneration) {
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
                  authority,
                )
              : deps.journal
                  .append(
                    input.documentId,
                    input.update,
                    deps.metaForOrigin(input.origin),
                    authority,
                  )
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
          const { admitted } = await requireBranchCoordinator().commitWriterUpdate({
            branchId: input.branchId,
            expectedGeneration: input.expectedGeneration,
            updateData: input.update,
            actorUserId: input.origin.type === "user" ? input.origin.userId : undefined,
            roomDocument: input.document,
          });
          if (admitted) deps.onBranchWriterUpdateAdmitted?.(input.branchId);
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
      if (isDocumentHandleRetired(document)) return;
      const authority = documentAuthority(document);
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
      const pending: PendingCheckpoint = { document, authority };
      // Releasing a server-side room runs this hook inline in the releaser's
      // async context, often inside its DB transaction. Capturing the cut takes the
      // document's mutation lock, so writing it here either holds that lock for
      // the rest of the caller's transaction or waits on a lock the caller holds;
      // either way a caller that then waits on another connection deadlocks.
      // A checkpoint only caches durable journal state, so it is written after
      // the caller commits, and skipped if the caller rolls back.
      afterCallerCommit(() => startCheckpoint(documentId, pending));
    },

    async storeHocuspocusBranch(branchId, _document) {
      await drainPending(`branch:${branchId}`);
      // Every branch mutation is durable before it reaches a Hocuspocus room, so a room
      // store has nothing to write: it only waits out this branch's pending stores.
    },

    async drainHocuspocusPersistence() {
      await drainPending();
      await drainCheckpoints();
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

    async disconnectLiveGeneration(documentId, generation) {
      const hocuspocus = deps.hocuspocus();
      // Hocuspocus publishes a room only after all load hooks complete. Its
      // registered continuation publishes before this one retires and evicts it.
      void hocuspocus?.loadingDocuments?.get(documentId)?.then(
        (loaded) => {
          if (
            isDocumentHandleRetired(loaded) ||
            documentAuthority(loaded).generation <= generation
          ) {
            retireRoom(documentId, loaded);
          }
        },
        () => {},
      );
      const document = hocuspocus?.documents.get(documentId);
      if (!hocuspocus || !document) return;
      if (!isDocumentHandleRetired(document) && documentAuthority(document).generation > generation)
        return;
      retiredStateVectors.set(documentId, Y.encodeStateVector(document));
      retireRoom(documentId, document);
    },

    async rejectStaleBranchSyncStep1(input) {
      // Before Hocuspocus answers the tab's step 1 from the room, the room catches up on
      // whatever committed that it missed: another process's commits, a dropped delivery
      // (decision D27). The tab's own exchange then brings the tab current, read-only or not.
      const base = await requireBranchCoordinator().reconcileRegisteredRoom({
        branchId: input.branchId,
        generation: input.generation,
        room: input.room,
        trigger: "handshake",
      });
      const stale =
        base?.snapshot.kind === "work_draft" &&
        branchSyncStep1IsStale(input.clientStateVector, {
          stateVector: Y.encodeStateVector(base.replica.doc),
          discardedStateVector: base.snapshot.discardedStateVector,
        });
      if (!stale) return false;
      recordDroppedConnectionUpdate(branchRoomName(input.branchId, input.generation));
      if (deps.eventSink) {
        emitEvent(deps.eventSink, {
          level: "warn",
          source: "collab.hocuspocus",
          name: "branch_sync_step1.fenced",
          correlation: { branchId: input.branchId, branchGeneration: input.generation },
          payload: {},
        });
      }
      return true;
    },

    getPersistenceQueueMetrics() {
      return latestMetrics();
    },
  };
}

/**
 * A client vector past the branch's current clocks only where a reset discarded them: the
 * tab still holds the previous generation's content.
 */
function branchSyncStep1IsStale(
  clientStateVector: Uint8Array,
  branch: { stateVector: Uint8Array; discardedStateVector?: Uint8Array | null },
): boolean {
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
