/**
 * A Work draft's room: loaded from the committed draft, its writer frames judged in the room
 * and stored with one insert, and caught up by reading the journal after each command commits
 * and whenever a tab connects. A room never receives pushed content, so a missed run heals at
 * the next one.
 */
import type { Hocuspocus, TransactionOrigin } from "@hocuspocus/server";
import { draftRoomName } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import { ownerOfColumns } from "../../shared/draft-owner.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../observability/index.js";
import type { CollabTransport } from "./contracts.js";
import type { DraftCoordinator } from "./domain/draft-coordinator.js";
import { DraftMissingError, type DraftStore } from "./domain/draft-store.js";
import { closeDraftRooms } from "./hocuspocus-rooms.js";
import type { WriterQueue } from "./writer-queue.js";

/** Content the room did not author: Hocuspocus broadcasts it to the room's tabs. */
const CATCH_UP_ORIGIN = {
  source: "local",
  context: { origin: { type: "system", reason: "draft-catch-up" } },
} satisfies TransactionOrigin;

export type DraftRoomDeps = {
  store: DraftStore;
  coordinator: DraftCoordinator;
  hocuspocus(): Hocuspocus | null;
  queue: WriterQueue;
  eventSink?: EventSink;
  /** Brings Live's committed text into a draft whose room just took a connection. */
  catchUpOpenedDraft?(draftId: string): Promise<void>;
  /** A writer's update to a draft is durable (the draft's own links register, §10.7). */
  onWriterAdmitted?(draftId: string): void;
};

export type DraftRoom = Pick<
  CollabTransport,
  | "resolveDraftHocuspocusRoom"
  | "draftExists"
  | "openDraftIds"
  | "openDraftRooms"
  | "loadHocuspocusDraftState"
  | "admitDraftWriterUpdate"
  | "storeHocuspocusDraft"
  | "drainHocuspocusDraftPersistence"
  | "closeHocuspocusDraftRoom"
  | "connectedHocuspocusDraftRoom"
  | "unloadedHocuspocusDraftRoom"
> & {
  /** Brings the draft's open room, if this process has one, up to the committed draft. */
  catchUp(draftId: string): Promise<void>;
};

export function createDraftRoom(deps: DraftRoomDeps): DraftRoom {
  const { store, coordinator, queue } = deps;
  // The draft rooms with a connection in this process, by document: what a Live commit pushes to.
  const roomsOf = new Map<DocumentId, Set<string>>();
  const documentOf = new Map<string, DocumentId>();

  async function catchUp(draftId: string): Promise<void> {
    const room = deps.hocuspocus()?.documents.get(draftRoomName(draftId));
    if (!room) return;
    try {
      const { replica } = await coordinator.loadBase(draftId);
      Y.applyUpdate(
        room,
        Y.encodeStateAsUpdate(replica.doc, Y.encodeStateVector(room)),
        CATCH_UP_ORIGIN,
      );
    } catch (cause) {
      if (cause instanceof DraftMissingError || !deps.eventSink) return;
      emitEvent(deps.eventSink, {
        level: "warn",
        source: "collab.draft_review",
        name: "draft_room_catch_up.failed",
        correlation: { draftId },
        payload: unknownToEventPayload(cause),
      });
    }
  }

  return {
    catchUp,

    async resolveDraftHocuspocusRoom(draftId) {
      const documentDraft = await store.getDraft(draftId);
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
      return (await store.getDraft(draftId)) !== null;
    },

    openDraftIds: (userId, draftIds) => store.openDraftIds(userId, draftIds),

    async openDraftRooms(documentId) {
      return [...(roomsOf.get(documentId) ?? [])];
    },

    async loadHocuspocusDraftState(draftId) {
      const documentDraft = await store.getDraft(draftId);
      if (documentDraft?.kind !== "work_draft") return undefined;
      return coordinator.readDraft(draftId, async (doc) => ({
        state: Y.encodeStateAsUpdate(doc),
      }));
    },

    admitDraftWriterUpdate(input) {
      const key = draftRoomName(input.draftId);
      const admission = (async () => {
        const novel = queue.judge({
          room: input.document,
          update: input.update,
          key,
          origin: input.origin,
          subject: { draftId: input.draftId },
        });
        if (!novel) return;
        await coordinator.appendWriterFrame({
          draftId: input.draftId,
          updateData: novel,
          actorUserId: input.origin.type === "user" ? input.origin.userId : undefined,
        });
        deps.onWriterAdmitted?.(input.draftId);
      })();
      // Register before validation's first await so shutdown cannot miss an
      // admission that Hocuspocus is already processing.
      queue.track(key, admission);
      return admission;
    },

    connectedHocuspocusDraftRoom({ draftId, documentId, document }) {
      // The room may have unloaded, or been replaced, while the connection was admitted: its
      // unload hook found nothing to remove, so listing it now would outlive it.
      if (deps.hocuspocus()?.documents.get(document.name) !== document) return;
      // Listed before the pull reads Live, so a Live commit from here on pushes to this room.
      roomsOf.set(documentId, (roomsOf.get(documentId) ?? new Set()).add(draftId));
      documentOf.set(draftId, documentId);
      queue.track(
        draftRoomName(draftId),
        // The load read the draft before the room registered: what committed in between
        // reached no room.
        catchUp(draftId).then(() => deps.catchUpOpenedDraft?.(draftId)),
      );
    },

    unloadedHocuspocusDraftRoom(draftId) {
      const documentId = documentOf.get(draftId);
      if (!documentId) return;
      documentOf.delete(draftId);
      const rooms = roomsOf.get(documentId);
      rooms?.delete(draftId);
      if (!rooms?.size) roomsOf.delete(documentId);
    },

    // Every draft mutation is durable before it reaches a room, so a room store has nothing to
    // write: it only waits out this draft's pending stores.
    storeHocuspocusDraft: (draftId) => queue.drain(draftRoomName(draftId)),

    drainHocuspocusDraftPersistence: (draftId) => queue.drain(draftRoomName(draftId)),

    closeHocuspocusDraftRoom(draftId) {
      closeDraftRooms(deps.hocuspocus(), draftId);
    },
  };
}
