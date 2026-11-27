import {
  CorruptDocBytesError,
  decodeDocVersion,
  decodeEnvelope,
  decodeRoomVersion,
  docCovers,
  encodeDocVersion,
  encodeEnvelope,
  encodeRoomVersion,
} from "@meridian/document-model";
import { decodeImportBlobMeta } from "loro-crdt";
import type { TreeList, TreeListStore } from "../domains/context/ports/tree-list-store.js";
import { emitEvent, unknownToEventPayload } from "../domains/observability/index.js";
import { createDetachedWorkTracker } from "../shared/detached-work.js";
import type { AppServices } from "./app.js";

const LIST_DOC = "s";

type Room = {
  listeners: Set<(batch: Uint8Array) => void>;
  sent: Uint8Array | null;
  catching: Promise<void> | null;
  stale: boolean;
};

export type TreeRoomServices = {
  treeLists: TreeListStore;
  eventSink: AppServices["eventSink"];
};

export function createTreeRooms(services: TreeRoomServices) {
  const { treeLists: store } = services;
  const rooms = new Map<string, Room>();
  const work = createDetachedWorkTracker();

  function catchUp(listId: string, room: Room): Promise<void> {
    room.stale = true;
    room.catching ??= (async () => {
      try {
        while (room.stale) {
          room.stale = false;
          const read = await store.readSince({ listId, version: room.sent ?? new Uint8Array() });
          room.sent = read.version;
          if (read.update.byteLength === 0) continue;
          const batch = encodeEnvelope(new Map([[LIST_DOC, read.update]]));
          for (const listener of room.listeners) listener(batch);
        }
      } finally {
        room.catching = null;
      }
    })();
    return work.track(room.catching);
  }

  const stopAdvanced = store.onListAdvanced((listId) => {
    const room = rooms.get(listId);
    if (!room) return;
    void catchUp(listId, room).catch((cause: unknown) =>
      emitEvent(services.eventSink, {
        level: "warn",
        source: "collab.tree_list",
        name: "catch_up.failed",
        payload: unknownToEventPayload(cause),
      }),
    );
  });

  return {
    open: (list: TreeList, accountId: string) => store.open({ list, accountId }),

    async sync(
      listId: string,
      clientVersion: Uint8Array,
    ): Promise<{ version: Uint8Array; update: Uint8Array | null }> {
      const known = decodeRoomVersion(clientVersion).get(LIST_DOC);
      const read = await store.readSince({
        listId,
        version: known ? encodeDocVersion(known) : new Uint8Array(),
      });
      const version = decodeDocVersion(read.version);
      const room = rooms.get(listId);
      if (room) room.sent ??= read.version;
      const behind = !known || !docCovers(known, version) || !docCovers(version, known);
      return {
        version: encodeRoomVersion(new Map([[LIST_DOC, version]])),
        update: behind ? encodeEnvelope(new Map([[LIST_DOC, read.update]])) : null,
      };
    },

    async write(list: TreeList, accountId: string, batch: Uint8Array): Promise<void> {
      const update = decodeEnvelope(batch).get(LIST_DOC);
      if (!update) return;
      try {
        const meta = decodeImportBlobMeta(update, true);
        meta.partialStartVersionVector.free();
        meta.partialEndVersionVector.free();
      } catch (error) {
        throw new CorruptDocBytesError(LIST_DOC, `not Loro bytes (${String(error)})`);
      }
      await store.admit({ list, accountId, update });
    },

    subscribe(listId: string, listener: (batch: Uint8Array) => void): () => void {
      let room = rooms.get(listId);
      if (!room) {
        room = { listeners: new Set(), sent: null, catching: null, stale: false };
        rooms.set(listId, room);
      }
      const held = room;
      held.listeners.add(listener);
      return () => {
        held.listeners.delete(listener);
        if (held.listeners.size === 0 && rooms.get(listId) === held) rooms.delete(listId);
      };
    },

    async dispose() {
      stopAdvanced();
      rooms.clear();
      await work.drain();
    },
  };
}

export type TreeRooms = ReturnType<typeof createTreeRooms>;
