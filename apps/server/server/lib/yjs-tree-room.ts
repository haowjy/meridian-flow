/**
 * A tree list's room: one long-lived Hocuspocus room per project, and one per account for
 * `user://`, beside the document rooms on the same gateway. Design:
 * `work/project-tree-design/design.md` section 4; the page beside this code is
 * `domains/context/.context/tree-list-store.md` ("The list's room").
 *
 * The journal is the truth and the store is the only writer: a client's update goes to
 * `TreeListStore.admit`, never straight into the room's document. What reaches the room's
 * document, and so every other connection, is the update the store committed (the client's items
 * with the verdicts the server appended after them), delivered from `onCommitted`.
 */

import type { Connection } from "@hocuspocus/server";
import { WS_CLOSE } from "@meridian/contracts/protocol";
import { splitSyncFrame } from "@meridian/tree-list-sync";
import { messageYjsSyncStep1, messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import type { TreeList, TreeListStore } from "../domains/context/ports/tree-list-store.js";
import { NO_WRITE_ACCESS } from "../domains/context/ports/tree-list-store.js";
import { emitEvent, unknownToEventPayload } from "../domains/observability/index.js";
import type { AppServices } from "./app.js";

/** What one part holds at most: a few hundred records, far under the admission's cap of 2,000. */
const PART_RECORDS = 300;

/** A Yjs update with no items is these two bytes: every connection's SyncStep2 may be one. */
const EMPTY_UPDATE_BYTES = 2;

/** Admissions one connection may burst, and how many it earns back each second. */
const BURST = 60;
const REFILL_PER_SECOND = 30;
/** A connection that would wait longer than this for its next admission is closed instead. */
const MAX_WAIT_MS = 10_000;

const SERVER_ORIGIN = "tree-list-room";

export type TreeRoomConnection = {
  list: TreeList;
  listId: string;
  level: "edit" | "read";
  accountId: string;
  /** Admissions available now, and when that was counted. */
  tokens: number;
  countedAt: number;
  /** Set once this connection's outgoing frames are cut into parts. */
  splitting: boolean;
};

type Room = {
  documentName: string;
  listId: string;
  document: Y.Doc;
  /** The journal row this room has applied through. */
  seq: number;
  catching: Promise<void> | null;
  /** A commit arrived while a catch-up was reading: read again. */
  stale: boolean;
};

export type TreeRoomServices = {
  treeLists: TreeListStore;
  eventSink: AppServices["eventSink"];
};

function closeWith(close: { code: number; reason: string }): Error {
  return Object.assign(new Error(close.reason), close);
}

export function createTreeRooms(services: TreeRoomServices) {
  const { treeLists: store } = services;
  const rooms = new Map<string, Room>();

  /**
   * Brings the room's document to the journal's head. A room only learns what another server
   * process committed here, at the next exchange that reads it (a connection's SyncStep1, an
   * admission): the same as a text room, which has no periodic reconciliation either.
   */
  function catchUp(room: Room): Promise<void> {
    room.stale = true;
    room.catching ??= (async () => {
      try {
        while (room.stale) {
          room.stale = false;
          const read = await store.readSince({ listId: room.listId, afterSeq: room.seq });
          Y.applyUpdate(room.document, read.update, SERVER_ORIGIN);
          room.seq = Math.max(room.seq, read.seq);
        }
      } finally {
        room.catching = null;
      }
    })();
    return room.catching;
  }

  // The committed update goes to the room at once, so every connection of this process hears it
  // (the one that sent it hears the verdicts); a catch-up then moves `seq` over it and any row
  // another process wrote before it.
  const stopListening = store.onCommitted((committed) => {
    const room = rooms.get(committed.listId);
    if (!room) return;
    Y.applyUpdate(room.document, committed.update, SERVER_ORIGIN);
    // The commit itself is already in the room; a failed read is repeated at the next exchange.
    void catchUp(room).catch((cause: unknown) =>
      emitEvent(services.eventSink, {
        level: "warn",
        source: "collab.tree_list",
        name: "catch_up.failed",
        payload: unknownToEventPayload(cause),
      }),
    );
  });

  function takeToken(state: TreeRoomConnection): number {
    const now = Date.now();
    state.tokens = Math.min(
      BURST,
      state.tokens + ((now - state.countedAt) / 1000) * REFILL_PER_SECOND,
    );
    state.countedAt = now;
    if (state.tokens >= 1) {
      state.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - state.tokens) / REFILL_PER_SECOND) * 1000);
  }

  return {
    /** A connection's access: the project (or account), not a document. */
    async connect(input: {
      list: TreeList;
      accountId: string;
      connectionConfig: { readOnly: boolean };
    }): Promise<TreeRoomConnection> {
      const access = await store.open({ list: input.list, accountId: input.accountId });
      if (!access) throw closeWith(WS_CLOSE.PERMISSION_DENIED);
      // Hocuspocus drops the updates of a read-only connection and answers SyncStatus(false).
      input.connectionConfig.readOnly = access.level === "read";
      return {
        list: input.list,
        listId: access.listId,
        level: access.level,
        accountId: input.accountId,
        tokens: BURST,
        countedAt: Date.now(),
        splitting: false,
      };
    },

    async load(input: { documentName: string; document: Y.Doc; tree: TreeRoomConnection }) {
      const read = await store.readSince({ listId: input.tree.listId, afterSeq: 0 });
      Y.applyUpdate(input.document, read.update, SERVER_ORIGIN);
      rooms.set(input.tree.listId, {
        documentName: input.documentName,
        listId: input.tree.listId,
        document: input.document,
        seq: read.seq,
        catching: null,
        stale: false,
      });
    },

    unloaded(documentName: string) {
      for (const [listId, room] of rooms)
        if (room.documentName === documentName) rooms.delete(listId);
    },

    /**
     * Runs before Hocuspocus applies a message. A SyncStep1 first brings the room to the journal's
     * head. An update goes to the store, which checks it and stores it: a whole refusal closes
     * the connection with `list-rebuild` and nothing is applied anywhere.
     */
    async beforeSync(input: {
      connection: Connection;
      tree: TreeRoomConnection;
      type: number;
      payload: Uint8Array;
    }) {
      const { connection, tree, type, payload } = input;
      if (!tree.splitting) {
        // What this connection lacks travels in parts, as what the server lacks from it does.
        tree.splitting = true;
        const send = connection.send.bind(connection);
        connection.send = (frame) => {
          for (const part of splitSyncFrame(frame, PART_RECORDS)) send(part);
        };
      }
      if (type === messageYjsSyncStep1) {
        const room = rooms.get(tree.listId);
        if (room) await catchUp(room);
        return;
      }
      if (type !== messageYjsSyncStep2 && type !== messageYjsUpdate) return;
      if (payload.length <= EMPTY_UPDATE_BYTES || tree.level === "read") return;
      const wait = takeToken(tree);
      if (wait > MAX_WAIT_MS) throw closeWith({ code: 1013, reason: "rate-limited" });
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const result = await store.admit({
        list: tree.list,
        accountId: tree.accountId,
        update: payload,
      });
      if (result.ok) return;
      if (result.reason === NO_WRITE_ACCESS) throw closeWith(WS_CLOSE.ACCESS_CHANGED);
      emitEvent(services.eventSink, {
        level: "warn",
        source: "collab.tree_list",
        name: "update.refused",
        payload: { listId: tree.listId, reason: result.reason },
      });
      throw closeWith(WS_CLOSE.LIST_REBUILD);
    },

    dispose() {
      stopListening();
      rooms.clear();
    },
  };
}

export type TreeRooms = ReturnType<typeof createTreeRooms>;
