// An in-memory host for the Loro core: the rooms adapter, write records, the model's edit list and
// turn Undo by content, for hand-run probes. The server's host does the same on Postgres.
import type { DocumentRoom } from "@meridian/contracts/protocol";
import {
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
import { takeBack } from "../content-merge/stands.js";
import type {
  AgentEditRooms,
  AgentWriteRecord,
  LoroDocumentEdits,
} from "../ports/document-rooms.js";
import { agentEditRooms } from "../ports/document-rooms.js";
import { editHandle } from "../ports/update-journal.js";

export interface InMemoryLoroHost {
  rooms: MemoryDocumentRooms;
  agentRooms: AgentEditRooms;
  journal: { reserveWriteOrdinal(documentId: string, threadId: string): Promise<number> };
  documentEdits: LoroDocumentEdits;
  records: AgentWriteRecord[];
  /** Run `work` as one command: its saves land, and import into the room, when it resolves. */
  command<T>(work: () => Promise<T>): Promise<T>;
  /** A first state for a document: these blocks, with ids. */
  seed(documentId: string, blocks: readonly PMNode[]): Promise<void>;
  /** The document's blocks in Live now, with ids. */
  live(documentId: string): Promise<PMNode[]>;
  /**
   * The writer types: `edit` returns the document they want from the one they see, and the
   * difference lands as a client's batch (a fresh client peer, no commit message).
   */
  writerEdit(documentId: string, edit: (blocks: PMNode[]) => PMNode[]): Promise<void>;
  /** Compact the document's history to now (design §4's cutoff), as an unload past the bound does. */
  compact(documentId: string): Promise<void>;
  /** The writer's turn Undo on a chat card: the turn's writes taken back by content (design §5). */
  undoTurn(documentId: string, turnId: string): Promise<{ taken: number }>;
  close(): Promise<void>;
}

const live = (documentId: string): DocumentRoom => ({ kind: "live", documentId });

export function createInMemoryLoroHost(schema: Schema): InMemoryLoroHost {
  const rooms = createMemoryDocumentRooms(shapeSchemaOf(schema));
  const records: AgentWriteRecord[] = [];
  const ordinals = new Map<string, number>();
  let tx: MemoryRoomTx | null = null;
  const pendingRecords: AgentWriteRecord[] = [];

  const agentRooms = agentEditRooms(rooms, {
    roomFor: async (documentId) => live(documentId),
    transaction() {
      if (!tx) throw new Error("A save outside a command");
      return tx;
    },
    origin: "server:agent",
    recordWrite: async (_tx, record) => {
      pendingRecords.push(record);
    },
  });

  const command = <T>(work: () => Promise<T>) =>
    rooms.transaction(async (current) => {
      tx = current;
      try {
        const result = await work();
        records.push(...pendingRecords.splice(0));
        return result;
      } finally {
        pendingRecords.length = 0;
        tx = null;
      }
    });

  const blocksIn = (docs: RoomDocs) => readDocument(docs).map((block) => nodeOf(schema, block));

  /** Write `blocks` as the document on a fresh copy and commit the difference as one batch. */
  const writeWhole = async (
    documentId: string,
    want: (current: PMNode[]) => PMNode[],
    options: { message?: string; asClient?: boolean },
  ) => {
    const room = live(documentId);
    const docs = await rooms.read(room, {
      peer: options.asClient ? freshPeerId() : freshServerPeerId(),
    });
    try {
      const since = docs.shownVersion();
      const next = want(blocksIn(docs));
      writeDocument(docs, blocksOf(schema.topNodeType.create(null, next)), {
        ...(options.message ? { message: options.message } : {}),
      });
      const update = docs.exportSince(since);
      if (update.size === 0) return;
      const batch = encodeEnvelope(update);
      if (options.asClient) await rooms.write(room, batch, "socket:writer");
      else await command(() => rooms.commit(tx as MemoryRoomTx, room, batch, "server:undo"));
    } finally {
      docs.free();
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
    async execute({ documentId, threadId, command: inverse }) {
      const mine = records.filter((r) => r.documentId === documentId && r.threadId === threadId);
      const chosen =
        inverse.command === "revert"
          ? mine.filter((r) => editHandle(r.wId) === inverse.edit)
          : mine.slice(-(inverse.count ?? 1)).reverse();
      if (chosen.length === 0) return { status: "invalid_write", message: "No such edit here." };
      let taken = 0;
      await writeWhole(
        documentId,
        (current) => {
          const back = takeBack(schema, current, chosen);
          taken = back.taken.length;
          return [...back.text];
        },
        { message: `undo:${chosen.map((r) => r.writeId).join(",")}` },
      );
      const names = chosen.map((r) => editHandle(r.wId)).join(", ");
      return {
        status: "success",
        message: taken ? `Took ${names} out.` : `${names} no longer stands in the text.`,
      };
    },
  };

  return {
    rooms,
    agentRooms,
    journal: {
      async reserveWriteOrdinal(documentId, threadId) {
        const key = `${documentId}\u0000${threadId}`;
        const next = (ordinals.get(key) ?? 0) + 1;
        ordinals.set(key, next);
        return next;
      },
    },
    documentEdits,
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
      // A loaded room imports a seed only after commit; this one was empty, so reload it.
      await rooms.unload(live(documentId));
    },
    async live(documentId) {
      const docs = await rooms.read(live(documentId));
      try {
        return blocksIn(docs);
      } finally {
        docs.free();
      }
    },
    writerEdit: (documentId, edit) => writeWhole(documentId, edit, { asClient: true }),
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
        .filter((r) => r.documentId === documentId && r.turnId === turnId)
        .reverse();
      let taken = 0;
      await writeWhole(
        documentId,
        (current) => {
          const back = takeBack(schema, current, parts);
          taken = back.taken.length;
          return [...back.text];
        },
        { message: `undo:turn:${turnId}` },
      );
      return { taken };
    },
    close: () => rooms.close(),
  };
}
