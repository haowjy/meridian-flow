/** Hocuspocus load/store persistence hooks and queue metrics for collab documents. */
import type { Hocuspocus } from "@hocuspocus/server";
import type { UpdateMeta } from "@meridian/agent-edit/integration";
import { draftRoomName, WS_CLOSE } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { RESERVED_CLIENT_ID_MAX } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { processDetachedWork } from "../../shared/detached-work.js";
import { ownerOfColumns } from "../../shared/draft-owner.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../observability/index.js";
import { loadDocumentState } from "./adapters/document-loader.js";
import type { CollabPersistenceMetrics, CollabTransport, UpdateOrigin } from "./contracts.js";
import { createDocumentContainment } from "./domain/document-containment.js";
import {
  documentAuthority,
  isDocumentHandleRetired,
  RetiredDocumentHandleError,
  retireDocumentHandle,
} from "./domain/document-handle.js";
import {
  assertWriterAuthorship,
  ReservedWriterClientIdError,
} from "./domain/document-mutation-policy.js";
import type { DraftCoordinator } from "./domain/draft-coordinator.js";
import type { DraftStore } from "./domain/draft-store.js";
import type {
  CheckpointAuthority,
  CheckpointJournal,
} from "./domain/ports/checkpoint-authority.js";
import type { LiveWriterJournal } from "./domain/ports/live-writer-journal.js";
import { ReservedNamespaceAdmissionError } from "./domain/provenance.js";
import { closeDraftRooms, closeRoom, whenRoomRegistered } from "./hocuspocus-rooms.js";

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
  journal: CheckpointJournal & LiveWriterJournal;
  draftStore?: DraftStore;
  draftCoordinator?: DraftCoordinator;
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
  /** Brings Live's committed text into a draft whose room just opened or took a connection. */
  catchUpOpenedDraft?(draftId: string): Promise<void>;
  /** A writer's update to a draft is durable (the draft's own links register, §10.7). */
  onDraftWriterUpdateAdmitted?(draftId: string): void;
};

export type HocuspocusPersistenceService = Pick<
  CollabTransport,
  | "resolveDraftHocuspocusRoom"
  | "draftExists"
  | "openDraftIds"
  | "openDraftRooms"
  | "loadHocuspocusDocument"
  | "loadHocuspocusDraftState"
  | "admitLiveWriterUpdate"
  | "currentLiveGeneration"
  | "validateHocuspocusDocument"
  | "admitDraftWriterUpdate"
  | "storeHocuspocusDocument"
  | "storeHocuspocusDraft"
  | "drainHocuspocusPersistence"
  | "drainHocuspocusDraftPersistence"
  | "closeHocuspocusDraftRoom"
  | "reconcileHocuspocusDraftRoom"
  | "enrollHocuspocusDraftRoom"
  | "connectedHocuspocusDraftRoom"
  | "unloadedHocuspocusDraftRoom"
  | "getPersistenceQueueMetrics"
> & {
  disconnectLiveGeneration(documentId: DocumentId, generation: bigint): Promise<void>;
};

export function createHocuspocusPersistenceService(
  deps: HocuspocusPersistenceDeps,
): HocuspocusPersistenceService {
  // The draft rooms open in this process, by document: what a Live commit pushes to.
  const draftRoomsOf = new Map<DocumentId, Set<string>>();
  const documentOfDraftRoom = new Map<string, DocumentId>();
  function unloadedDraftRoom(draftId: string): void {
    const documentId = documentOfDraftRoom.get(draftId);
    if (!documentId) return;
    documentOfDraftRoom.delete(draftId);
    const rooms = draftRoomsOf.get(documentId);
    rooms?.delete(draftId);
    if (!rooms?.size) draftRoomsOf.delete(documentId);
  }
  const pendingAppends = new Map<number, PendingAppend>();
  const droppedByDocument = new Map<string, number>();
  // A reconnected client has current transport authority but can replay cached
  // pre-restore structs/deletes. Handle fencing cannot identify that byte history.
  const retiredStateVectors = new Map<string, Uint8Array>();
  const checkpointSlots = new Map<string, CheckpointSlot>();
  const afterCallerCommit = deps.afterCallerCommit ?? ((callback: () => void) => callback());
  const documentContainment = createDocumentContainment();
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
    created.running = processDetachedWork.track(
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

  function requireDraftStore(): DraftStore {
    if (!deps.draftStore) throw new Error("Draft Hocuspocus rooms require a draft store");
    return deps.draftStore;
  }

  function requireDraftCoordinator(): DraftCoordinator {
    if (!deps.draftCoordinator) {
      throw new Error("Draft Hocuspocus rooms require a draft coordinator");
    }
    return deps.draftCoordinator;
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
    validateHocuspocusDocument,
    async currentLiveGeneration(documentId) {
      return (await deps.readAuthorityHeadGeneration?.(documentId)) ?? 1n;
    },

    async resolveDraftHocuspocusRoom(draftId) {
      const documentDraft = await requireDraftStore().getDraft(draftId);
      const owner = documentDraft && ownerOfColumns(documentDraft);
      if (documentDraft?.kind !== "work_draft" || !owner) return null;
      return {
        draftId: documentDraft.draftId,
        documentId: documentDraft.documentId,
        owner,
        schemaVersion: documentDraft.schemaVersion,
      };
    },

    async draftExists(draftId) {
      return (await requireDraftStore().getDraft(draftId)) !== null;
    },

    async openDraftIds(userId, draftIds) {
      return requireDraftStore().openDraftIds(userId, draftIds);
    },

    async openDraftRooms(documentId) {
      return [...(draftRoomsOf.get(documentId) ?? [])];
    },

    async loadHocuspocusDocument(documentId, document) {
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

    async loadHocuspocusDraftState(draftId) {
      const documentDraft = await requireDraftStore().getDraft(draftId);
      if (documentDraft?.kind !== "work_draft") return undefined;
      return requireDraftCoordinator().readDraft(draftId, async (doc) => ({
        state: Y.encodeStateAsUpdate(doc),
      }));
    },

    enrollHocuspocusDraftRoom({ draftId, document }) {
      const hocuspocus = deps.hocuspocus();
      if (!hocuspocus) return;
      const enrollment = (async () => {
        // The load read the draft before its room became a delivery recipient: whatever
        // committed in between reached no room.
        if (!(await whenRoomRegistered(hocuspocus, document))) return;
        const base = await requireDraftCoordinator().reconcileRegisteredRoom({
          draftId,
          room: document,
          trigger: "enrollment",
        });
        if (!base) {
          closeRoom(hocuspocus, document, WS_CLOSE.DRAFT_PURGED);
          return;
        }
        // The room may have unloaded, or been replaced, while the read above ran: its unload
        // hook found nothing to remove, so listing it now would outlive it.
        if (hocuspocus.documents.get(document.name) !== document) return;
        const documentId = base.snapshot.documentId as DocumentId;
        draftRoomsOf.set(documentId, (draftRoomsOf.get(documentId) ?? new Set()).add(draftId));
        documentOfDraftRoom.set(draftId, documentId);
        // Listed, so a Live commit from here on pushes to this room, and this pull reads
        // whatever committed before it.
        await deps.catchUpOpenedDraft?.(draftId);
      })().catch((cause: unknown) => {
        if (!deps.eventSink) return;
        emitEvent(deps.eventSink, {
          level: "error",
          source: "collab.hocuspocus",
          name: "draft_room_enrollment.failed",
          correlation: { draftId },
          payload: unknownToEventPayload(cause),
        });
      });
      // A store of this room, and a drain of this draft, wait the enrollment out.
      trackAppend(draftRoomName(draftId), enrollment);
    },

    connectedHocuspocusDraftRoom(draftId) {
      // A room still enrolling catches up when it finishes.
      if (documentOfDraftRoom.has(draftId)) void deps.catchUpOpenedDraft?.(draftId);
    },

    unloadedHocuspocusDraftRoom: unloadedDraftRoom,

    async admitLiveWriterUpdate(input) {
      const room = input.document;
      const authority = documentAuthority(room);
      if (authority.generation !== input.expectedGeneration) {
        recordDroppedConnectionUpdate(input.documentId);
        throw new Error("stale-durable-authority-generation");
      }
      if (deps.hocuspocus()?.documents.get(input.documentId) !== room) {
        throw new Error("live-document-room-mismatch");
      }
      const retiredStateVector = retiredStateVectors.get(input.documentId);
      if (retiredStateVector && replaysRetiredGeneration(input.update, room, retiredStateVector)) {
        recordDroppedConnectionUpdate(input.documentId);
        throw new Error("retired-durable-authority-generation");
      }
      // Reconnects replay state the room already holds: acknowledged, nothing stored.
      if (documentContainment.contains(room, input.update)) return { admitted: false };
      try {
        assertWriterAuthorship(room, input.update);
      } catch (cause) {
        if (!(cause instanceof ReservedWriterClientIdError)) throw cause;
        recordDroppedConnectionUpdate(input.documentId);
        deps.emitAgentEditInvariantViolation({
          message: `Rejected connection update for document ${input.documentId}: Yjs clientID ${cause.clientId} is in the reserved server-authored band [0, ${RESERVED_CLIENT_ID_MAX}].`,
          documentId: input.documentId,
          originType: input.origin.type,
          reservedClientId: cause.clientId,
          reservedClientIdMax: RESERVED_CLIENT_ID_MAX,
        });
        throw new Error("reserved-writer-client-id");
      }
      let novel: Uint8Array;
      try {
        novel = newToRoom(room, input.update);
      } catch (cause) {
        if (cause instanceof WriterFrameGapError) recordDroppedConnectionUpdate(input.documentId);
        throw cause;
      }
      const append = deps.journal.appendWriterUpdate(
        input.documentId,
        novel,
        deps.metaForOrigin(input.origin),
        authority,
      );
      trackAppend(input.documentId, append);
      try {
        await append;
      } catch (cause) {
        // The head moved on (a restore): this room's state belongs to the old generation.
        if (cause instanceof RetiredDocumentHandleError) retireRoom(input.documentId, room);
        throw cause;
      }
      return { admitted: true };
    },

    admitDraftWriterUpdate(input) {
      const queueKey = draftRoomName(input.draftId);
      const admission = (async () => {
        try {
          const { admitted } = await requireDraftCoordinator().commitWriterUpdate({
            draftId: input.draftId,
            updateData: input.update,
            actorUserId: input.origin.type === "user" ? input.origin.userId : undefined,
            roomDocument: input.document,
          });
          if (admitted) deps.onDraftWriterUpdateAdmitted?.(input.draftId);
        } catch (cause) {
          if (
            cause instanceof ReservedNamespaceAdmissionError ||
            cause instanceof ReservedWriterClientIdError
          ) {
            deps.emitAgentEditInvariantViolation({
              message: `Rejected client-authored provenance update for draft ${input.draftId}.`,
              draftId: input.draftId,
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

    async storeHocuspocusDraft(draftId, _document) {
      await drainPending(`draft:${draftId}`);
      // Every draft mutation is durable before it reaches a Hocuspocus room, so a room
      // store has nothing to write: it only waits out this draft's pending stores.
    },

    async drainHocuspocusPersistence() {
      await drainPending();
      await drainCheckpoints();
    },

    drainHocuspocusDraftPersistence(draftId) {
      return drainPending(`draft:${draftId}`);
    },

    closeHocuspocusDraftRoom(draftId) {
      closeDraftRooms(deps.hocuspocus(), draftId);
    },

    async disconnectLiveGeneration(documentId, generation) {
      const hocuspocus = deps.hocuspocus();
      // Hocuspocus serves a room only after all load hooks complete. Its
      // registered continuation runs before this one retires and evicts it.
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

    async reconcileHocuspocusDraftRoom(input) {
      // Before Hocuspocus answers the tab's step 1 from the room, the room catches up on
      // whatever committed that it missed: another process's commits, a dropped delivery.
      // The tab's own exchange then brings the tab current, read-only or not.
      const base = await requireDraftCoordinator().reconcileRegisteredRoom({
        draftId: input.draftId,
        room: input.room,
        trigger: "handshake",
      });
      return !!base;
    },

    getPersistenceQueueMetrics() {
      return latestMetrics();
    },
  };
}

class WriterFrameGapError extends Error {
  constructor() {
    super("writer-frame-gap");
  }
}

/**
 * What of `update` the room lacks. A frame that starts past the room's clock for one of its
 * clients is not storable: no later read could integrate it, so the socket closes and the
 * reconnect's handshake carries the prefix.
 */
function newToRoom(room: Y.Doc, update: Uint8Array): Uint8Array {
  const stateVector = Y.encodeStateVector(room);
  const clocks = Y.decodeStateVector(stateVector);
  let overlaps = false;
  for (const [client, from] of Y.parseUpdateMeta(update).from) {
    const held = clocks.get(client) ?? 0;
    if (from > held) throw new WriterFrameGapError();
    if (from < held) overlaps = true;
  }
  return overlaps ? Y.diffUpdate(update, stateVector) : update;
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
