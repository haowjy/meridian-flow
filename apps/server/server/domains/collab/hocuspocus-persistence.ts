/** Hocuspocus load/store persistence hooks and queue metrics for collab documents. */
import type { Hocuspocus } from "@hocuspocus/server";
import { bytesEqual, type UpdateJournal, type UpdateMeta } from "@meridian/agent-edit";
import { branchRoomName } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { isReservedClientId, RESERVED_CLIENT_ID_MAX } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { type EventSink, emitEvent } from "../observability/index.js";
import { loadDocumentState } from "./adapters/document-loader.js";
import {
  type BranchCoordinator,
  type BranchSnapshot,
  BranchStaleUpdateError,
  type BranchStore,
} from "./domain/branch-coordinator.js";
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
  emitAgentEditInvariantViolation(payload: Record<string, unknown>): void;
  onLiveUpdatePersisted?(documentId: DocumentId): void;
};

export type HocuspocusPersistenceService = Pick<
  CollabTransport,
  | "resolveBranchHocuspocusRoom"
  | "loadHocuspocusDocument"
  | "loadHocuspocusBranchState"
  | "persistConnectionUpdate"
  | "persistBranchConnectionUpdate"
  | "storeHocuspocusDocument"
  | "storeHocuspocusBranch"
  | "drainHocuspocusPersistence"
  | "drainHocuspocusBranchPersistence"
  | "closeHocuspocusBranchRoom"
  | "rejectStaleBranchSyncStep1"
  | "getPersistenceQueueMetrics"
>;

export function createHocuspocusPersistenceService(
  deps: HocuspocusPersistenceDeps,
): HocuspocusPersistenceService {
  const pendingAppends = new Map<number, PendingAppend>();
  const droppedByDocument = new Map<string, number>();
  const unsafeCheckpointDocuments = new Map<string, number>();
  let nextPendingId = 1;

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

    persistConnectionUpdate(input) {
      const reservedClientId = reservedClientIdInUpdate(input.update);
      if (reservedClientId !== null) {
        rejectReservedClientIdUpdate({ ...input, reservedClientId });
        return;
      }
      trackAppend(
        input.documentId,
        deps.journal
          .append(input.documentId, input.update, deps.metaForOrigin(input.origin))
          .then(() => deps.onLiveUpdatePersisted?.(input.documentId)),
      );
    },

    async persistBranchConnectionUpdate(input) {
      const reservedClientId = reservedClientIdInUpdate(input.update);
      const queueKey = branchRoomName(input.branchId, input.expectedGeneration);
      if (reservedClientId !== null) {
        recordDroppedConnectionUpdate(queueKey);
        deps.emitAgentEditInvariantViolation({
          message: `Rejected connection update for branch ${input.branchId}: Yjs clientID ${reservedClientId} is in the reserved server-authored band [0, ${RESERVED_CLIENT_ID_MAX}].`,
          branchId: input.branchId,
          originType: input.origin.type,
          reservedClientId,
          reservedClientIdMax: RESERVED_CLIENT_ID_MAX,
        });
        return;
      }
      const current = await requireBranchStore().getBranch(input.branchId);
      if (
        current?.status !== "active" ||
        current.kind !== "work_draft" ||
        current.generation !== input.expectedGeneration ||
        !documentContainsState(input.document, current.state)
      ) {
        throw new BranchStaleUpdateError(input.branchId);
      }
      const append = requireBranchCoordinator()
        .commitUpdate({
          branchId: input.branchId,
          updateData: input.update,
          source: "writer",
          actorUserId: input.origin.type === "user" ? input.origin.userId : undefined,
          expectedGeneration: input.expectedGeneration,
        })
        .catch((cause) => {
          emitPersistenceAppendFailure(queueKey, cause);
          throw cause;
        });
      trackAppend(queueKey, append);
      await append;
    },

    async storeHocuspocusDocument(documentId, document) {
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
      await requireBranchCoordinator().checkpointBranch(branchId);
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

function reservedClientIdInUpdate(update: Uint8Array): number | null {
  return (
    Y.decodeUpdate(update).structs.find((struct) => isReservedClientId(struct.id.client))?.id
      .client ?? null
  );
}

function documentContainsState(document: Y.Doc, state: Uint8Array): boolean {
  if (!stateVectorCovers(Y.encodeStateVector(document), Y.encodeStateVectorFromUpdate(state))) {
    return false;
  }
  const probe = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(document));
    const before = Y.encodeStateAsUpdate(probe);
    Y.applyUpdate(probe, state);
    return bytesEqual(before, Y.encodeStateAsUpdate(probe));
  } finally {
    probe.destroy();
  }
}

function stateVectorCovers(candidate: Uint8Array, required: Uint8Array): boolean {
  const candidateClocks = Y.decodeStateVector(candidate);
  for (const [client, requiredClock] of Y.decodeStateVector(required)) {
    if ((candidateClocks.get(client) ?? 0) < requiredClock) return false;
  }
  return true;
}
