/**
 * Presence on `/ws/loro` (design §4): each room's `%EPH` channel, relayed between the sockets on
 * it. The server keeps one ephemeral store per room so a socket that joins hears who is there,
 * and clears what a socket wrote when it leaves, so its caret goes from the other screens at once
 * instead of when its entry times out.
 */
import { freshBatchId } from "@meridian/contracts/protocol";
import { EphemeralStore } from "loro-crdt";
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
    // The server writes only deletions: a leaving member's keys, which the others must drop.
    const offLocal = store.subscribeLocalUpdates((bytes) => {
      for (const member of room.members.values()) member.send(frame(roomId, bytes));
    });
    room.stop = () => {
      offImport();
      offLocal();
      store.destroy();
    };
    rooms.set(roomId, room);
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

    /** Free every room's store: the server is stopping. */
    dispose() {
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
