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
import type { DocumentEdits } from "../ports/document-edits.js";
import type { AgentEditRooms, AgentWriteRecord } from "../ports/document-rooms.js";
import { agentEditRooms } from "../ports/document-rooms.js";
import { editHandle } from "../ports/write-ordinals.js";
import { undoInRooms } from "../undo-in-rooms.js";

/** What a chat's core runs on: its rooms and its edit history. */
export interface InMemoryChatRooms {
  rooms: AgentEditRooms;
  documentEdits: DocumentEdits;
}

export interface InMemoryHost {
  rooms: MemoryDocumentRooms;
  /**
   * A chat's door: Live for `null`, else the draft's fork room from the first read, whether or not
   * the draft has written there (design §5). One core per mode; a chat that switches mode keeps
   * its frontiers, which live in its context.
   */
  chat(draftId: string | null): InMemoryChatRooms;
  ordinals: { reserveWriteOrdinal(documentId: string, threadId: string): Promise<number> };
  records: AgentWriteRecord[];
  /** Run `work` as one command: its saves land, and import into the room, when it resolves. */
  command<T>(work: () => Promise<T>): Promise<T>;
  /** A first state for a document: these blocks, with ids. */
  seed(documentId: string, blocks: readonly PMNode[]): Promise<void>;
  /** The document's blocks in Live now, with ids. */
  live(documentId: string): Promise<PMNode[]>;
  /** The document's blocks as the draft reads them now (Live's where it wrote nothing), with ids. */
  draft(documentId: string, draftId: string): Promise<PMNode[]>;
  /**
   * The writer types, in Live or in a Draft page: `edit` returns the document they want from the
   * one they see, and the difference lands as a client's batch (a fresh client peer, no commit
   * message).
   */
  writerEdit(
    documentId: string,
    edit: (blocks: PMNode[]) => PMNode[],
    draftId?: string,
  ): Promise<void>;
  /**
   * The writer's Apply or Discard in Review changes: the draft's changes naming these blocks (or
   * all), pressed as the server's press does (design §2), Live's room committed first. Returns
   * how many changes it acted on.
   */
  press(
    kind: "apply" | "discard",
    documentId: string,
    draftId: string,
    selection: ChangeSelection,
  ): Promise<number>;
  /**
   * A Draft-mode turn's restore press: the turn's writes into the fork taken back by the
   * Undo rule, newest first (design §2). Returns how many went back.
   */
  restoreTurn(documentId: string, draftId: string, turnId: string): Promise<number>;
  /** Compact the document's history to now (design §4's cutoff), as an unload past the bound does. */
  compact(documentId: string): Promise<void>;
  /** The writer's turn Undo on a chat card: the turn's writes taken back, each in its room (design §5). */
  undoTurn(documentId: string, turnId: string): Promise<{ taken: number }>;
  close(): Promise<void>;
}

const live = (documentId: string): DocumentRoom => ({ kind: "live", documentId });
const fork = (documentId: string, draftId: string): DocumentRoom => ({
  kind: "fork",
  draftId,
  documentId,
});

export function createInMemoryHost(schema: Schema): InMemoryHost {
  const rooms = createMemoryDocumentRooms(shapeSchemaOf(schema));
  const records: AgentWriteRecord[] = [];
  /** Writes an inverse took back: the model's undo goes past them, as the server's does. */
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

  /** The writer's typing: `want`'s document from a fresh client's copy, sent as one batch. */
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

  /**
   * `parts` taken back, each in the room it landed in, newest first as given, by the planner the
   * server runs (`undoInRooms`). Returns the parts that went, and those whose history was cut.
   */
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

  const documentEdits: DocumentEdits = {
    async read({ documentId, threadId }) {
      const mine = records.filter((r) => r.documentId === documentId && r.threadId === threadId);
      if (mine.length === 0) return { status: "success", message: "No edits by this chat." };
      return {
        status: "success",
        message: mine
          .map((record) => {
            const before = record.delta?.before.length ?? 0;
            const after = record.delta?.after.length ?? 0;
            return `${editHandle(record.wId)}: ${before} block(s) before, ${after} after`;
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
      // The model's inverse names its turn, as its writes do.
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
      // A loaded room imports a seed only after commit; this one was empty, so reload it.
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
    async restoreTurn(documentId, draftId, turnId) {
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
      // The writer's card Undo is the writer's.
      return { taken: (await takeBackIn(parts)).taken.length };
    },
    close: () => rooms.close(),
  };
}
