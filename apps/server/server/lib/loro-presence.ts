import { freshBatchId } from "@meridian/contracts/protocol";
import { EphemeralStore } from "loro-crdt";
import { CrdtType, MessageType, type ProtocolMessage } from "loro-protocol";

const PRESENCE_TIMEOUT_MS = 30_000;

type Send = (message: ProtocolMessage) => void;

interface PresenceRoom {
  store: EphemeralStore;
  members: Map<object, { send: Send; keys: Set<string> }>;
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
    join(member: object, roomId: string, send: Send) {
      const room = open(roomId);
      room.members.set(member, { send, keys: room.members.get(member)?.keys ?? new Set() });
      const all = room.store.encodeAll();
      if (all.byteLength > 0) send(frame(roomId, all));
    },

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
