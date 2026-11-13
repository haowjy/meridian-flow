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

import { treeRoomName, WS_CLOSE } from "@meridian/contracts/protocol";
import { messageYjsSyncStep1, messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import type { TreeList, TreeListStore } from "../domains/context/ports/tree-list-store.js";
import { NO_WRITE_ACCESS } from "../domains/context/ports/tree-list-store.js";
import { emitEvent, unknownToEventPayload } from "../domains/observability/index.js";
import type { AppServices } from "./app.js";

/** A Yjs update with no items is these two bytes: every connection's SyncStep2 may be one. */
const EMPTY_UPDATE_BYTES = 2;

/**
 * Admissions one connection may burst, and how many it earns back each second. Each admission
 * spends one token at once; a connection out of tokens is held back until its debt is earned
 * back, and closed when that would take longer than `MAX_WAIT_MS`.
 */
const BURST = 60;
const REFILL_PER_SECOND = 30;
const MAX_WAIT_MS = 10_000;

/** What the client reconnects on: a fault of the server's, not a refusal of the connection. */
export const SERVER_ERROR_CLOSE = { code: 1013, reason: "tree-list-unavailable" };

const SERVER_ORIGIN = "tree-list-room";

type RoomClose = { code: number; reason: string };

/**
 * A refusal of a connection: the gateway closes the socket with this code before Hocuspocus
 * answers, so the client hears the real code (Hocuspocus's own close reaches it as 1000).
 */
export class TreeRoomRefusal extends Error {
  constructor(readonly close: RoomClose) {
    super(close.reason);
  }
}

export type TreeRoomConnection = {
  list: TreeList;
  listId: string;
  level: "edit" | "read";
  accountId: string;
  /** Admissions available now (negative while the connection owes its wait), and when counted. */
  tokens: number;
  countedAt: number;
  /** Set by the first refusal: Hocuspocus still runs the messages queued behind it, and none may reach the store. */
  refusal: RoomClose | null;
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

/** A refusal that also shuts the connection against the messages queued behind it. */
function refusal(tree: TreeRoomConnection, close: RoomClose): TreeRoomRefusal {
  tree.refusal = close;
  return new TreeRoomRefusal(close);
}

export function createTreeRooms(services: TreeRoomServices) {
  const { treeLists: store } = services;
  const rooms = new Map<string, Room>();

  /**
   * Brings the room's document to the journal's head: after a commit on any process (the
   * store's notification) and at each connection's SyncStep1, which also heals a notification
   * this process missed while its listener was reconnecting.
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

  // This process's own commit reaches its connections at once (the sender hears the verdicts);
  // the notification that follows moves `seq` over it and over any row another process wrote.
  const stopCommitted = store.onCommitted((committed) => {
    const room = rooms.get(committed.listId);
    if (room) Y.applyUpdate(room.document, committed.update, SERVER_ORIGIN);
  });
  const stopAdvanced = store.onJournalAdvanced((listId) => {
    const room = rooms.get(listId);
    if (!room) return;
    void catchUp(room).catch((cause: unknown) =>
      emitEvent(services.eventSink, {
        level: "warn",
        source: "collab.tree_list",
        name: "catch_up.failed",
        payload: unknownToEventPayload(cause),
      }),
    );
  });

  /** Spends one admission's token and says how long the connection must wait for it. */
  function reserveToken(state: TreeRoomConnection): number {
    const now = Date.now();
    state.tokens = Math.min(
      BURST,
      state.tokens + ((now - state.countedAt) / 1000) * REFILL_PER_SECOND,
    );
    state.countedAt = now;
    state.tokens -= 1;
    return state.tokens >= 0 ? 0 : Math.ceil((-state.tokens / REFILL_PER_SECOND) * 1000);
  }

  /** What one message needs before Hocuspocus applies it. */
  async function admitMessage(tree: TreeRoomConnection, type: number, payload: Uint8Array) {
    if (type === messageYjsSyncStep1) {
      const room = rooms.get(tree.listId);
      if (room) await catchUp(room);
      return;
    }
    if (type !== messageYjsSyncStep2 && type !== messageYjsUpdate) return;
    if (payload.length <= EMPTY_UPDATE_BYTES || tree.level === "read") return;
    const wait = reserveToken(tree);
    if (wait > MAX_WAIT_MS) throw refusal(tree, { code: 1013, reason: "rate-limited" });
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const result = await store.admit({
      list: tree.list,
      accountId: tree.accountId,
      update: payload,
    });
    if (result.ok) return;
    if (result.reason === NO_WRITE_ACCESS) throw refusal(tree, WS_CLOSE.ACCESS_CHANGED);
    emitEvent(services.eventSink, {
      level: "warn",
      source: "collab.tree_list",
      name: "update.refused",
      payload: { listId: tree.listId, reason: result.reason },
    });
    throw refusal(tree, WS_CLOSE.LIST_REBUILD);
  }

  return {
    /**
     * A connection's access: the project (or account), not a document. `register` enrolls the
     * connection with the gateway's access index, which closes it when the access ends.
     */
    async connect(input: {
      list: TreeList;
      accountId: string;
      connectionConfig: { readOnly: boolean };
      register(roomName: string): void;
    }): Promise<TreeRoomConnection> {
      const access = await store.open({ list: input.list, accountId: input.accountId });
      if (!access) throw new TreeRoomRefusal(WS_CLOSE.PERMISSION_DENIED);
      input.register(treeRoomName(input.list));
      // A change between the check and the registration reached no one: ask once more.
      const settled = await store.open({ list: input.list, accountId: input.accountId });
      if (settled?.level !== access.level) throw new TreeRoomRefusal(WS_CLOSE.ACCESS_CHANGED);
      // Hocuspocus drops the updates of a read-only connection and answers SyncStatus(false).
      input.connectionConfig.readOnly = access.level === "read";
      return {
        list: input.list,
        listId: access.listId,
        level: access.level,
        accountId: input.accountId,
        tokens: BURST,
        countedAt: Date.now(),
        refusal: null,
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
     * the connection with `list-rebuild` and nothing is applied anywhere. Throws
     * `TreeRoomRefusal` to refuse; any other error is the gateway's to turn into a close.
     */
    async beforeSync(input: { tree: TreeRoomConnection; type: number; payload: Uint8Array }) {
      const { tree } = input;
      if (tree.refusal) throw new TreeRoomRefusal(tree.refusal);
      try {
        await admitMessage(tree, input.type, input.payload);
      } catch (cause) {
        // The gateway closes the socket on any error; the queued messages behind it must find it closed.
        tree.refusal ??= SERVER_ERROR_CLOSE;
        throw cause;
      }
    },

    dispose() {
      stopCommitted();
      stopAdvanced();
      rooms.clear();
    },
  };
}

export type TreeRooms = ReturnType<typeof createTreeRooms>;
