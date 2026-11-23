// An in-memory host for the Loro core: the rooms adapter for a Live or a Draft chat, write records,
// the model's edit list, undo and revert by content in the room each write landed in, and the
// writer's turn Undo, Apply, Discard and `Restore before`, for hand-run probes. The server's host
// does the same on Postgres.
import { type DocumentRoom, liveRoomOf, loroRoomName } from "@meridian/contracts/protocol";
import {
  applyBlocks,
  type ChangeSelection,
  type DocKey,
  type DocVersion,
  decodeEnvelope,
  discardBlocks,
  encodeChanges,
  encodeEnvelope,
  freshPeerId,
  freshServerPeerId,
  type RoomDocs,
  readDocument,
  restoreBefore,
  STRUCTURE_KEY,
  updateEnd,
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
import { editHandle } from "../ports/write-ordinals.js";

/** What a chat's core runs on: its rooms and its edit history. */
export interface InMemoryChatRooms {
  rooms: AgentEditRooms;
  documentEdits: LoroDocumentEdits;
}

export interface InMemoryLoroHost {
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
  /** A Draft-mode turn card's `Restore before`: the fork back to the turn's start (design §2). */
  restoreBefore(documentId: string, draftId: string, turnId: string): Promise<void>;
  /** Compact the document's history to now (design §4's cutoff), as an unload past the bound does. */
  compact(documentId: string): Promise<void>;
  /** The writer's turn Undo on a Live chat card: the turn's writes taken back by content (design §5). */
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
  const batches = new Map<AgentWriteRecord, Uint8Array>();
  const ordinals = new Map<string, number>();
  let tx: MemoryRoomTx | null = null;
  const pending: { record: AgentWriteRecord; batch: Uint8Array }[] = [];
  let presses = 0;

  const command = <T>(work: () => Promise<T>) =>
    rooms.transaction(async (current) => {
      tx = current;
      try {
        const result = await work();
        for (const { record, batch } of pending.splice(0)) {
          records.push(record);
          batches.set(record, batch);
        }
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

  /** Write `blocks` as the document on a fresh copy and commit the difference as one batch. */
  const writeWhole = async (
    room: DocumentRoom,
    want: (current: PMNode[]) => PMNode[],
    options: { message?: string; asClient?: boolean },
  ) => {
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
      else await command(() => rooms.commit(inCommand(), room, batch, "server:undo"));
    } finally {
      docs.free();
    }
  };

  /**
   * `parts` taken back by content, each in the room it landed in, newest first as given. A change
   * someone has written over since stays whole (design §2's Undo rule, by content): `takeBack`
   * leaves a change that no longer stands.
   */
  const takeBackIn = async (parts: readonly AgentWriteRecord[], message: string) => {
    const taken: AgentWriteRecord[] = [];
    const roomsOf = [...new Map(parts.map((r) => [loroRoomName(r.room), r.room])).values()];
    for (const room of roomsOf) {
      const here = parts.filter((r) => loroRoomName(r.room) === loroRoomName(room));
      await writeWhole(
        room,
        (current) => {
          const back = takeBack(schema, current, here);
          taken.push(...back.taken);
          return [...back.text];
        },
        { message },
      );
    }
    return taken;
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
          : mine.slice(-(inverse.count ?? 1)).reverse();
      if (chosen.length === 0) return { status: "invalid_write", message: "No such edit here." };
      // The model's inverse names its turn, as its writes do.
      const taken = await takeBackIn(chosen, `turn:${context.turnId ?? "model"}`);
      const names = (parts: readonly AgentWriteRecord[]) =>
        parts.map((r) => editHandle(r.wId)).join(", ");
      const stayed = chosen.filter((r) => !taken.includes(r));
      return {
        status: "success",
        message: [
          ...(taken.length ? [`Took ${names(taken)} out.`] : []),
          ...(stayed.length
            ? [
                `${names(stayed)} stays: someone has written over it since, so it is left as they have it.`,
              ]
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
      recordWrite: async (_tx, record, batch) => {
        pending.push({ record, batch });
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
      writeWhole(draftId ? fork(documentId, draftId) : live(documentId), edit, { asClient: true }),
    async press(kind, documentId, draftId, selection) {
      const room = fork(documentId, draftId);
      const docs = await rooms.read(room);
      try {
        const message = `press:${++presses}`;
        const pressed =
          kind === "apply"
            ? applyBlocks(docs, selection, {
                message,
                liveVersion: (docs.live as RoomDocs).version(),
              })
            : discardBlocks(docs, selection, { message });
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
      const room = fork(documentId, draftId);
      const writes = records.filter(
        (r) =>
          r.documentId === documentId &&
          r.turnId === turnId &&
          loroRoomName(r.room) === loroRoomName(room),
      );
      const before = new Map<DocKey, DocVersion>();
      for (const write of writes)
        for (const [key, at] of write.before) if (!before.has(key)) before.set(key, at);
      const last = writes.at(-1);
      const structure = last && decodeEnvelope(batches.get(last) as Uint8Array).get(STRUCTURE_KEY);
      const docs = await rooms.read(room);
      try {
        const changes = restoreBefore(
          docs,
          { before, after: structure ? updateEnd(structure) : null },
          { message: `restore:turn:${turnId}` },
        );
        if (changes.length)
          await command(() =>
            rooms.commit(inCommand(), room, encodeChanges(changes), "server:restore-before"),
          );
      } finally {
        docs.free();
      }
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
        .filter((r) => r.documentId === documentId && r.turnId === turnId)
        .reverse();
      return { taken: (await takeBackIn(parts, `undo:turn:${turnId}`)).length };
    },
    close: () => rooms.close(),
  };
}
