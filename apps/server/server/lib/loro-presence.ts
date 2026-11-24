/**
 * Presence on `/ws/loro` (design §4): each room's `%EPH` channel, relayed between the sockets on
 * it. The server keeps one ephemeral store per room so a socket that joins hears who is there,
 * and clears what a socket wrote when it leaves, so its caret goes from the other screens at once
 * instead of when its entry times out. The server publishes entries of its own too (an agent's
 * caret, `agent-presence.ts`): held until it clears them, whether or not a socket is on the room.
 */
import { freshBatchId } from "@meridian/contracts/protocol";
import { EphemeralStore, type Value } from "loro-crdt";
import { CrdtType, MessageType, type ProtocolMessage } from "loro-protocol";

/** A peer's entry expires this long after its last update, as the client's does. */
const PRESENCE_TIMEOUT_MS = 30_000;

type Send = (message: ProtocolMessage) => void;

interface PresenceRoom {
  store: EphemeralStore;
  /** Each member's send, and the keys it wrote. */
  members: Map<object, { send: Send; keys: Set<string> }>;
  /** The member whose update is being applied, credited with the keys it touches. */
  applying: object | null;
  stop(): void;
}

export function createPresenceRelay() {
  const rooms = new Map<string, PresenceRoom>();
  /** The server's own entries, by room and key. */
  const held = new Map<string, Map<string, Value>>();
  // Peers drop an entry PRESENCE_TIMEOUT_MS after its last write, so a held entry is re-sent.
  let refresh: ReturnType<typeof setInterval> | null = null;
  const refreshHeld = () => {
    for (const [roomId, entries] of held)
      for (const [key, value] of entries) rooms.get(roomId)?.store.set(key, value);
  };

  function open(roomId: string): PresenceRoom {
    const existing = rooms.get(roomId);
    if (existing) return existing;
    const store = new EphemeralStore(PRESENCE_TIMEOUT_MS);
    const room: PresenceRoom = { store, members: new Map(), applying: null, stop: () => {} };
    const offImport = store.subscribe((event) => {
      if (event.by !== "import" || !room.applying) return;
      const keys = room.members.get(room.applying)?.keys;
      for (const key of [...event.added, ...event.updated]) keys?.add(key);
      for (const key of event.removed) keys?.delete(key);
    });
    // The server's own writes: its entries, and a leaving member's keys, which the others drop.
    const offLocal = store.subscribeLocalUpdates((bytes) => {
      for (const member of room.members.values()) member.send(frame(roomId, bytes));
    });
    room.stop = () => {
      offImport();
      offLocal();
      store.destroy();
    };
    rooms.set(roomId, room);
    for (const [key, value] of held.get(roomId) ?? []) store.set(key, value);
    return room;
  }

  return {
    /** A socket joins a room's presence: it hears the presence the room holds now. */
    join(member: object, roomId: string, send: Send) {
      const room = open(roomId);
      room.members.set(member, { send, keys: room.members.get(member)?.keys ?? new Set() });
      const all = room.store.encodeAll();
      if (all.byteLength > 0) send(frame(roomId, all));
    },

    /** A member's update: kept, and sent to the room's other members. Not acknowledged. */
    update(member: object, roomId: string, updates: readonly Uint8Array[]) {
      const room = rooms.get(roomId);
      if (!room?.members.has(member)) return;
      room.applying = member;
      try {
        for (const update of updates) room.store.apply(update);
      } finally {
        room.applying = null;
      }
      for (const [other, { send }] of room.members)
        if (other !== member) for (const update of updates) send(frame(roomId, update));
    },

    /** A socket leaves a room's presence: what it wrote is deleted for everyone else. */
    leave(member: object, roomId: string) {
      const room = rooms.get(roomId);
      const left = room?.members.get(member);
      if (!room || !left) return;
      room.members.delete(member);
      for (const key of left.keys) room.store.delete(key);
      if (room.members.size === 0) {
        room.stop();
        rooms.delete(roomId);
      }
    },

    /**
     * The server's own entry `key` in a room, sent to its sockets and to every socket that joins
     * until it is cleared with null.
     */
    publish(roomId: string, key: string, value: Value | null) {
      const entries = held.get(roomId) ?? new Map<string, Value>();
      if (value === null) {
        entries.delete(key);
        rooms.get(roomId)?.store.delete(key);
      } else {
        entries.set(key, value);
        rooms.get(roomId)?.store.set(key, value);
      }
      if (entries.size > 0) held.set(roomId, entries);
      else held.delete(roomId);
      if (held.size > 0 && !refresh) {
        refresh = setInterval(refreshHeld, PRESENCE_TIMEOUT_MS / 3);
        refresh.unref?.();
      } else if (held.size === 0 && refresh) {
        clearInterval(refresh);
        refresh = null;
      }
    },

    /** Free every room's store: the server is stopping. */
    dispose() {
      if (refresh) clearInterval(refresh);
      refresh = null;
      held.clear();
      for (const room of rooms.values()) room.stop();
      rooms.clear();
    },
  };
}

export type PresenceRelay = ReturnType<typeof createPresenceRelay>;

function frame(roomId: string, update: Uint8Array): ProtocolMessage {
  return {
    type: MessageType.DocUpdate,
    crdt: CrdtType.LoroEphemeralStore,
    roomId,
    updates: [update],
    batchId: freshBatchId(),
  };
}
