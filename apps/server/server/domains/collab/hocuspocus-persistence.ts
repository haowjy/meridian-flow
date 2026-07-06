/** Hocuspocus load/store persistence hooks and queue metrics for collab documents. */
import type { Hocuspocus } from "@hocuspocus/server";
import type { UpdateJournal, UpdateMeta } from "@meridian/agent-edit";
import { branchRoomName, draftRoomName } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { isReservedClientId, RESERVED_CLIENT_ID_MAX } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { type EventSink, emitEvent } from "../observability/index.js";
import { loadDocumentState } from "./adapters/document-loader.js";
import type { BranchCoordinator, BranchStore } from "./domain/branch-coordinator.js";
import { buildStoredDraftProjection } from "./domain/draft-projection.js";
import type { DraftStore } from "./domain/drafts.js";
import type { CollabPersistenceMetrics, CollabTransport, UpdateOrigin } from "./index.js";

type PendingAppend = {
  documentId: string;
  startedAt: number;
  promise: Promise<void>;
};

type HocuspocusPersistenceDeps = {
  journal: UpdateJournal;
  draftStore?: Pick<DraftStore, "getDraft" | "appendUpdate" | "listUpdates">;
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
  | "resolveDraftHocuspocusRoom"
  | "resolveBranchHocuspocusRoom"
  | "loadHocuspocusDocument"
  | "loadHocuspocusDraft"
  | "loadHocuspocusBranch"
  | "persistConnectionUpdate"
  | "persistDraftConnectionUpdate"
  | "persistBranchConnectionUpdate"
  | "storeHocuspocusDocument"
  | "storeHocuspocusDraft"
  | "storeHocuspocusBranch"
  | "drainHocuspocusPersistence"
  | "drainHocuspocusDraftPersistence"
  | "drainHocuspocusBranchPersistence"
  | "closeHocuspocusDraftRoom"
  | "closeHocuspocusBranchRoom"
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
        (entry) => !documentId || entry.documentId === documentId,
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

  function emitDraftAppendRejected(draftId: string, cause: unknown): void {
    if (!deps.eventSink) return;
    emitEvent(deps.eventSink, {
      level: "warn",
      source: "collab.hocuspocus",
      name: "draft_append.rejected",
      payload: {
        draftId,
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

  function requireDraftStore(): Pick<DraftStore, "getDraft" | "appendUpdate" | "listUpdates"> {
    if (!deps.draftStore) throw new Error("Draft Hocuspocus rooms require a draft store");
    return deps.draftStore;
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
    async resolveDraftHocuspocusRoom(draftId) {
      const draft = await requireDraftStore().getDraft(draftId);
      if (draft?.status !== "active") return null;
      return { draftId: draft.id, documentId: draft.documentId, status: draft.status };
    },

    async resolveBranchHocuspocusRoom(branchId) {
      const branch = await requireBranchStore().getBranch(branchId);
      if (branch?.status !== "active" || branch.kind !== "work_draft") return null;
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

    async loadHocuspocusDraft(draftId) {
      const draft = await requireDraftStore().getDraft(draftId);
      if (draft?.status !== "active") return undefined;
      const doc = await buildStoredDraftProjection(
        deps.journal,
        requireDraftStore(),
        draft.documentId,
        draft.id,
        draft.baseLiveUpdateSeq,
      );
      try {
        return Y.encodeStateAsUpdate(doc);
      } finally {
        doc.destroy();
      }
    },

    async loadHocuspocusBranch(branchId) {
      const branch = await requireBranchStore().getBranch(branchId);
      if (branch?.status !== "active" || branch.kind !== "work_draft") return undefined;
      return requireBranchCoordinator().withBranch(branchId, async (doc) =>
        Y.encodeStateAsUpdate(doc),
      );
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

    persistDraftConnectionUpdate(input) {
      const reservedClientId = reservedClientIdInUpdate(input.update);
      const queueKey = draftRoomName(input.draftId);
      if (reservedClientId !== null) {
        recordDroppedConnectionUpdate(queueKey);
        deps.emitAgentEditInvariantViolation({
          message: `Rejected connection update for draft ${input.draftId}: Yjs clientID ${reservedClientId} is in the reserved server-authored band [0, ${RESERVED_CLIENT_ID_MAX}].`,
          draftId: input.draftId,
          originType: input.origin.type,
          reservedClientId,
          reservedClientIdMax: RESERVED_CLIENT_ID_MAX,
        });
        return;
      }
      trackAppend(
        queueKey,
        requireDraftStore()
          .appendUpdate({
            draftId: input.draftId,
            updateData: input.update,
            actorUserId: input.origin.type === "user" ? input.origin.userId : undefined,
          })
          .catch((cause) => {
            emitDraftAppendRejected(input.draftId, cause);
            throw cause;
          }),
      );
    },

    persistBranchConnectionUpdate(input) {
      const reservedClientId = reservedClientIdInUpdate(input.update);
      const queueKey = branchRoomName(input.branchId);
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
      trackAppend(
        queueKey,
        requireBranchCoordinator().commitUpdate({
          branchId: input.branchId,
          updateData: input.update,
          source: "writer",
          actorUserId: input.origin.type === "user" ? input.origin.userId : undefined,
        }),
      );
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

    async storeHocuspocusDraft(_draftId, _document) {
      // Active draft rows must remain individually addressable for reconstructInverse;
      // draft-room store intentionally never checkpoints or compacts them.
    },

    async storeHocuspocusBranch(branchId, _document) {
      await drainPending(branchRoomName(branchId));
      await requireBranchCoordinator().checkpointBranch(branchId);
    },

    drainHocuspocusPersistence() {
      return drainPending();
    },

    drainHocuspocusDraftPersistence(draftId) {
      return drainPending(draftRoomName(draftId));
    },

    drainHocuspocusBranchPersistence(branchId) {
      return drainPending(branchRoomName(branchId));
    },

    closeHocuspocusDraftRoom(draftId) {
      const hocuspocus = deps.hocuspocus();
      hocuspocus?.closeConnections(draftRoomName(draftId));
    },

    closeHocuspocusBranchRoom(branchId) {
      const hocuspocus = deps.hocuspocus();
      hocuspocus?.closeConnections(branchRoomName(branchId));
    },

    getPersistenceQueueMetrics() {
      return latestMetrics();
    },
  };
}

function reservedClientIdInUpdate(update: Uint8Array): number | null {
  return (
    Y.decodeUpdate(update).structs.find((struct) => isReservedClientId(struct.id.client))?.id
      .client ?? null
  );
}
