import {
  CorruptDocBytesError,
  decodeEnvelope,
  decodeRoomVersion,
  encodeEnvelope,
  encodeRoomVersion,
} from "@meridian/document-model";
import { decodeImportBlobMeta, VersionVector } from "loro-crdt";
import type { TreeList, TreeListStore } from "../domains/context/ports/tree-list-store.js";
import { emitEvent, unknownToEventPayload } from "../domains/observability/index.js";
import { createDetachedWorkTracker } from "../shared/detached-work.js";
import type { AppServices } from "./app.js";

/**
 * A tree list's room on `/ws/loro` (`tree:project:<id>`, `tree:account:<id>`): one Loro doc, the
 * list, under doc key `s`, framed in the same envelope and room version as a document's rooms.
 * The stored list is the truth and the store the only writer: a client's update goes to
 * `TreeListStore.admit`, as sent; what reaches the room's sockets is the stored list past what the
 * room last sent (the client's records with the stamps the server appended after them), read
 * after each commit on any process (`onListAdvanced`).
 */
const LIST_DOC = "s";

type Room = {
  listeners: Set<(batch: Uint8Array) => void>;
  /** The stored version the room's sockets were sent through; null before the first read. */
  sent: VersionVector | null;
  catching: Promise<void> | null;
  /** A commit arrived while a catch-up was reading: read again. */
  stale: boolean;
};

export type TreeRoomServices = {
  treeLists: TreeListStore;
  eventSink: AppServices["eventSink"];
};

export function createTreeRooms(services: TreeRoomServices) {
  const { treeLists: store } = services;
  const rooms = new Map<string, Room>();
  // Every catch-up a commit notification fires on its own: `dispose` waits for them, so a closed
  // gateway leaves no read open.
  const work = createDetachedWorkTracker();

  function catchUp(listId: string, room: Room): Promise<void> {
    room.stale = true;
    room.catching ??= (async () => {
      try {
        while (room.stale) {
          room.stale = false;
          const read = await store.readSince({
            listId,
            version: room.sent?.encode() ?? new Uint8Array(),
          });
          room.sent = VersionVector.decode(read.version);
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
    /** The list's id when the account may open it; null when the list is not the account's. */
    async open(list: TreeList, accountId: string): Promise<string | null> {
      return (await store.open({ list, accountId }))?.listId ?? null;
    },

    /**
     * The stored list past the client's room version, as an envelope (null when the client has
     * it all), and the stored version as a room version.
     */
    async sync(
      listId: string,
      clientVersion: Uint8Array,
    ): Promise<{ version: Uint8Array; update: Uint8Array | null }> {
      const known = decodeRoomVersion(clientVersion).get(LIST_DOC);
      const read = await store.readSince({ listId, version: known?.encode() ?? new Uint8Array() });
      const version = VersionVector.decode(read.version);
      const room = rooms.get(listId);
      if (room) room.sent ??= version;
      const behind = !known || known.compare(version) !== 0;
      return {
        version: encodeRoomVersion(new Map([[LIST_DOC, version]])),
        update: behind ? encodeEnvelope(new Map([[LIST_DOC, read.update]])) : null,
      };
    },

    /**
     * Admits the list's entry of a client's envelope, as sent. Throws `CorruptDocBytesError` for
     * bytes that are not a Loro update. An entry under any other key is no part of a list.
     */
    async write(list: TreeList, accountId: string, batch: Uint8Array): Promise<void> {
      const update = decodeEnvelope(batch).get(LIST_DOC);
      if (!update) return;
      try {
        decodeImportBlobMeta(update, true);
      } catch (error) {
        throw new CorruptDocBytesError(LIST_DOC, `not Loro bytes (${String(error)})`);
      }
      await store.admit({ list, accountId, update });
    },

    /** Hears the list's stored changes as envelopes, until the returned function is called. */
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

    /** Stops listening and resolves once the catch-ups the rooms started have settled. */
    async dispose() {
      stopAdvanced();
      rooms.clear();
      await work.drain();
    },
  };
}

export type TreeRooms = ReturnType<typeof createTreeRooms>;
