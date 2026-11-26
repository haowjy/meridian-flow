// An in-memory host for the Loro core: the rooms adapter for a Live or a Draft chat, write records,
// the model's edit list, undo and revert on the one Undo rule in the room each write landed in, and the
// writer's turn Undo, Apply, Discard and a turn's restore press, for hand-run probes. The server's host
// does the same on Postgres.
import { type DocumentRoom, liveRoomOf, loroRoomName } from "@meridian/contracts/protocol";
import {
  applyBlocks,
  type ChangeSelection,
  type CommitAuthor,
  discardBlocks,
  encodeChanges,
  encodeEnvelope,
  freshPeerId,
  freshServerPeerId,
  type RoomDocs,
  readDocument,
  writeDocument,
} from "@meridian/document-model";
import {
  createMemoryDocumentRooms,
  type MemoryDocumentRooms,
  type MemoryRoomTx,
} from "@meridian/document-model/rooms";
import { blocksOf, nodeOf, shapeSchemaOf } from "@meridian/loro-prosemirror";
import type { Node as PMNode, Schema } from "prosemirror-model";
import type {
  AgentEditRooms,
  AgentWriteRecord,
  LoroDocumentEdits,
} from "../ports/document-rooms.js";
import { agentEditRooms } from "../ports/document-rooms.js";
import { editHandle } from "../ports/write-ordinals.js";
import { undoInRooms } from "../undo-in-rooms.js";

export interface InMemoryChatRooms {
  rooms: AgentEditRooms;
  documentEdits: LoroDocumentEdits;
}

export interface InMemoryLoroHost {
  rooms: MemoryDocumentRooms;
  chat(draftId: string | null): InMemoryChatRooms;
  ordinals: { reserveWriteOrdinal(documentId: string, threadId: string): Promise<number> };
  records: AgentWriteRecord[];
  command<T>(work: () => Promise<T>): Promise<T>;
  seed(documentId: string, blocks: readonly PMNode[]): Promise<void>;
  live(documentId: string): Promise<PMNode[]>;
  draft(documentId: string, draftId: string): Promise<PMNode[]>;
  writerEdit(
    documentId: string,
    edit: (blocks: PMNode[]) => PMNode[],
    draftId?: string,
  ): Promise<void>;
  press(
    kind: "apply" | "discard",
    documentId: string,
    draftId: string,
    selection: ChangeSelection,
  ): Promise<number>;
  restoreBefore(documentId: string, draftId: string, turnId: string): Promise<number>;
  compact(documentId: string): Promise<void>;
  undoTurn(documentId: string, turnId: string): Promise<{ taken: number }>;
  close(): Promise<void>;
}

const live = (documentId: string): DocumentRoom => ({ kind: "live", documentId });
const fork = (documentId: string, draftId: string): DocumentRoom => ({
  kind: "fork",
  draftId,
  documentId,
});

export function createInMemoryLoroHost(schema: Schema): InMemoryLoroHost {
  const rooms = createMemoryDocumentRooms(shapeSchemaOf(schema));
  const records: AgentWriteRecord[] = [];
  const takenBack = new Set<AgentWriteRecord>();
  const ordinals = new Map<string, number>();
  let tx: MemoryRoomTx | null = null;
  const pending: AgentWriteRecord[] = [];
  let presses = 0;

  const command = <T>(work: () => Promise<T>) =>
    rooms.transaction(async (current) => {
      tx = current;
      try {
        const result = await work();
        records.push(...pending.splice(0));
        return result;
      } finally {
        pending.length = 0;
        tx = null;
      }
    });
  const inCommand = () => {
    if (!tx) throw new Error("A save outside a command");
    return tx;
  };

  const blocksIn = (docs: RoomDocs) => readDocument(docs).map((block) => nodeOf(schema, block));
  const read = async (room: DocumentRoom) => {
    const docs = await rooms.read(room);
    try {
      return blocksIn(docs);
    } finally {
      docs.free();
    }
  };

  const writerWrite = async (room: DocumentRoom, want: (current: PMNode[]) => PMNode[]) => {
    const docs = await rooms.read(room, { peer: freshPeerId() });
    try {
      const since = docs.shownVersion();
      writeDocument(docs, blocksOf(schema.topNodeType.create(null, want(blocksIn(docs)))));
      const update = docs.exportSince(since);
      if (update.size > 0) await rooms.write(room, encodeEnvelope(update), "socket:writer");
    } finally {
      docs.free();
    }
  };

  const takeBackIn = async (parts: readonly AgentWriteRecord[], by?: CommitAuthor) => {
    const held = new Map<string, RoomDocs>();
    try {
      for (const { room } of parts)
        if (!held.has(loroRoomName(room))) held.set(loroRoomName(room), await rooms.read(room));
      const undone = undoInRooms(parts, (room) => held.get(loroRoomName(room)) as RoomDocs, by);
      for (const { room, changes } of undone.rooms)
        await command(() => rooms.commit(inCommand(), room, encodeChanges(changes), "server:undo"));
      const taken = parts.filter((part) => !undone.compacted.has(part));
      for (const record of taken) takenBack.add(record);
      return { taken, compacted: undone.compacted };
    } finally {
      for (const docs of held.values()) docs.free();
    }
  };

  const documentEdits: LoroDocumentEdits = {
    async read({ documentId, threadId }) {
      const mine = records.filter((r) => r.documentId === documentId && r.threadId === threadId);
      if (mine.length === 0) return { status: "success", message: "No edits by this chat." };
      return {
        status: "success",
        message: mine
          .map((record) => {
            const before = record.delta?.before.length ?? 0;
            const after = record.delta?.after.length ?? 0;
            return `${editHandle(record.wId)} (${record.writeId}): ${before} block(s) before, ${after} after`;
          })
          .join("\n"),
      };
    },
    async execute({ documentId, threadId, context, command: inverse }) {
      const mine = records.filter((r) => r.documentId === documentId && r.threadId === threadId);
      const chosen =
        inverse.command === "revert"
          ? mine.filter((r) => editHandle(r.wId) === inverse.edit)
          : mine
              .filter((r) => !takenBack.has(r))
              .slice(-(inverse.count ?? 1))
              .reverse();
      if (chosen.length === 0) return { status: "invalid_write", message: "No such edit here." };
      if (chosen.every((r) => takenBack.has(r)))
        return {
          status: "success",
          message: `${editHandle(chosen[0].wId)} is already taken back.`,
        };
      const { taken, compacted } = await takeBackIn(chosen, { turn: context.turnId ?? "model" });
      const names = (parts: readonly AgentWriteRecord[]) =>
        parts.map((r) => editHandle(r.wId)).join(", ");
      const kept = chosen.filter((r) => compacted.has(r));
      return {
        status: "success",
        message: [
          ...(taken.length ? [`Took ${names(taken)} out.`] : []),
          ...(kept.length
            ? [`${names(kept)} stays: the document no longer keeps history that old.`]
            : []),
        ].join(" "),
      };
    },
  };

  const chat = (draftId: string | null): InMemoryChatRooms => ({
    rooms: agentEditRooms(rooms, {
      roomFor: async (documentId) => (draftId ? fork(documentId, draftId) : live(documentId)),
      transaction: inCommand,
      origin: "server:agent",
      recordWrite: async (_tx, record) => {
        pending.push(record);
      },
    }),
    documentEdits,
  });

  return {
    rooms,
    chat,
    ordinals: {
      async reserveWriteOrdinal(documentId, threadId) {
        const key = `${documentId}\u0000${threadId}`;
        const next = (ordinals.get(key) ?? 0) + 1;
        ordinals.set(key, next);
        return next;
      },
    },
    records,
    command,
    async seed(documentId, blocks) {
      const docs = (await rooms.read(live(documentId))).fork(freshServerPeerId());
      try {
        writeDocument(docs, blocksOf(schema.topNodeType.create(null, [...blocks])));
        await rooms.transaction((current) =>
          rooms.seed(current, live(documentId), encodeEnvelope(docs.snapshots())),
        );
      } finally {
        docs.free();
      }
      await rooms.unload(live(documentId));
    },
    live: (documentId) => read(live(documentId)),
    draft: (documentId, draftId) => read(fork(documentId, draftId)),
    writerEdit: (documentId, edit, draftId) =>
      writerWrite(draftId ? fork(documentId, draftId) : live(documentId), edit),
    async press(kind, documentId, draftId, selection) {
      const room = fork(documentId, draftId);
      const docs = await rooms.read(room);
      try {
        const by = { press: String(++presses) };
        const pressed =
          kind === "apply"
            ? applyBlocks(docs, selection, {
                by,
                liveVersion: (docs.live as RoomDocs).version(),
              })
            : discardBlocks(docs, selection, { by });
        await command(async () => {
          if (pressed.live.length)
            await rooms.commit(
              inCommand(),
              liveRoomOf(room),
              encodeChanges(pressed.live),
              "server:press",
            );
          if (pressed.fork.length)
            await rooms.commit(inCommand(), room, encodeChanges(pressed.fork), "server:press");
        });
        return pressed.chosen.length;
      } finally {
        docs.free();
      }
    },
    async restoreBefore(documentId, draftId, turnId) {
      const room = loroRoomName(fork(documentId, draftId));
      const parts = records
        .filter(
          (r) =>
            r.documentId === documentId && r.turnId === turnId && loroRoomName(r.room) === room,
        )
        .reverse();
      const { taken } = await takeBackIn(parts, { press: String(++presses) });
      return taken.length;
    },
    async compact(documentId) {
      const docs = await rooms.read(live(documentId));
      const rows = new Map<string, Uint8Array>();
      try {
        for (const [key, doc] of docs.owned())
          rows.set(key, doc.export({ mode: "shallow-snapshot", frontiers: doc.frontiers() }));
      } finally {
        docs.free();
      }
      await rooms.unload(live(documentId));
      await rooms.transaction((current) =>
        rooms.seed(current, live(documentId), encodeEnvelope(rows)),
      );
    },
    async undoTurn(documentId, turnId) {
      const parts = records
        .filter((r) => r.documentId === documentId && r.turnId === turnId && !takenBack.has(r))
        .reverse();
      return { taken: (await takeBackIn(parts)).taken.length };
    },
    close: () => rooms.close(),
  };
}
