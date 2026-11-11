/**
 * Proof-of-concept: the file-tree log through the production Hocuspocus room and persistence,
 * held to text-convergence.test.ts's bar. Writers' tree updates arrive shuffled, half of them
 * reach the warm room only through storage, and the room reloads after every delivery; the
 * room, the stored doc and every writer must end on one valid tree holding every accepted op.
 */
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { createYjsRoomAccessIndex } from "../../../lib/yjs-room-access.js";
import { admitWriterSync, createHocuspocus } from "../../../lib/yjs-ws-handler.js";
import { createAllowAllFileAccess, createLocalFileAccessChanges } from "../../file-policy/index.js";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createInMemoryJournal } from "../adapters/in-memory/agent-edit.js";
import { createHocuspocusPersistenceService } from "../hocuspocus-persistence.js";
import {
  fingerprint,
  LIVE,
  materialize,
  opsOf,
  ROOT,
  TreeWriter,
  treeViolations,
} from "./tree-log.js";

const TREE_ID = "00000000-0000-4000-8000-0000000000aa" as never;
const USER_ID = "00000000-0000-4000-8000-000000000002" as never;

function seededShuffle<T>(items: T[], seed: number): T[] {
  const shuffled = [...items];
  let state = seed >>> 0;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const other = state % (index + 1);
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

describe("file tree log through the production room", () => {
  for (const seed of [0x5eedc0df, 1, 2, 3, 4]) {
    it(`keeps every accepted tree op across shuffled room and storage deliveries (seed ${seed})`, async () => {
      const journal = createInMemoryJournal();
      const seedDoc = createCollabYDoc({ gc: false });
      const seeder = new TreeWriter(seedDoc);
      const arc = seeder.create(LIVE, "user:w", { kind: "folder", name: "Arc", parent: ROOT }).node;
      const lore = seeder.create(LIVE, "user:w", {
        kind: "folder",
        name: "Lore",
        parent: ROOT,
      }).node;
      const ch = seeder.create(LIVE, "user:w", { kind: "document", name: "Ch1", parent: arc }).node;
      await journal.seedInitialDocument(TREE_ID, Y.encodeStateAsUpdate(seedDoc));

      let hocuspocus: ReturnType<typeof createHocuspocus>;
      const persistence = createHocuspocusPersistenceService({
        journal,
        hocuspocus: () => hocuspocus,
        metaForOrigin: () => ({ origin: "human:test-user", seq: 0 }),
        emitAgentEditInvariantViolation: () => undefined,
      });
      const services = {
        liveDocuments: {
          findById: async () => ({
            kind: "found" as const,
            document: {} as never,
            clashesWith: [],
          }),
        },
        fileAccess: createAllowAllFileAccess(),
        fileAccessChanges: createLocalFileAccessChanges(),
        documentSync: {
          ...persistence,
          bindHocuspocus: () => undefined,
          currentLiveGeneration: async () => 1n,
          primeReservedNamespaceIndex: () => undefined,
          roomRemoval: async () => null,
        },
        eventSink: createInMemoryEventSink(),
      };
      hocuspocus = createHocuspocus(services as never, createYjsRoomAccessIndex());

      let connection = await hocuspocus.openDirectConnection(TREE_ID, { userId: USER_ID } as never);
      const initial = Y.encodeStateAsUpdate(connection.document as never);
      const writers = [0, 1, 2].map(() => {
        const doc = createCollabYDoc({ gc: false });
        Y.applyUpdate(doc, initial);
        const updates: Uint8Array[] = [];
        doc.on("update", (update: Uint8Array, origin: unknown) => {
          if (origin !== "remote") updates.push(update);
        });
        return { writer: new TreeWriter(doc), updates };
      });
      const [w0, w1, w2] = writers as [
        (typeof writers)[0],
        (typeof writers)[0],
        (typeof writers)[0],
      ];
      // The conflicts that break trees, all concurrent: a cycle, move against delete, create in
      // a deleted folder, rename against rename, and a draft applied while live moves on.
      w0.writer.move(LIVE, "user:w", arc, lore);
      w1.writer.move(LIVE, "agent:t/1", lore, arc);
      w0.writer.delete(LIVE, "user:w", arc);
      w2.writer.move(LIVE, "agent:t/2", ch, ROOT);
      w1.writer.create(LIVE, "agent:t/1", { kind: "document", name: "Ch2", parent: arc });
      w0.writer.rename(LIVE, "user:w", ch, "Prologue");
      w2.writer.rename(LIVE, "agent:t/2", ch, "Opening");
      w2.writer.create({ draft: "w" }, "agent:t/2", {
        kind: "document",
        name: "Map",
        parent: lore,
      });
      w2.writer.apply("w", "user:w");

      const deliveries = seededShuffle(
        writers.flatMap(({ updates }) => updates),
        seed,
      );
      try {
        for (const [index, update] of deliveries.entries()) {
          const room = connection.document;
          if (!room) throw new Error("The test room disconnected before delivery");
          await admitWriterSync({
            services: services as never,
            documentName: TREE_ID,
            document: room,
            syncType: messageYjsUpdate,
            payload: update,
            userId: USER_ID,
            expectedGeneration: 1n,
          });
          if (index % 2 === 0) Y.applyUpdate(room, update);
          await connection.disconnect();
          await persistence.drainHocuspocusPersistence();
          connection = await hocuspocus.openDirectConnection(TREE_ID, { userId: USER_ID } as never);
        }
        const finalRoom = connection.document as Y.Doc;
        const stored = createCollabYDoc({ gc: false });
        const state = await persistence.loadHocuspocusDocument(TREE_ID, stored);
        if (state) Y.applyUpdate(stored, state);
        const accepted = new Set([
          ...opsOf(seedDoc)
            .toArray()
            .map((op) => op.id),
          ...writers.flatMap(({ writer }) =>
            opsOf(writer.doc)
              .toArray()
              .map((op) => op.id),
          ),
        ]);
        const finalState = Y.encodeStateAsUpdate(finalRoom);
        for (const { writer } of writers) Y.applyUpdate(writer.doc, finalState, "remote");

        const docs = [finalRoom, stored, ...writers.map(({ writer }) => writer.doc)];
        const prints = docs.map((doc) => fingerprint(materialize(doc, LIVE)));
        expect(new Set(prints).size).toBe(1);
        expect(
          new Set(
            opsOf(stored)
              .toArray()
              .map((op) => op.id),
          ),
        ).toEqual(accepted);
        const live = materialize(stored, LIVE);
        expect(treeViolations(live)).toEqual([]);
        expect(live.skipped.some((skip) => skip.reason === "cycle")).toBe(true);
        stored.destroy();
      } finally {
        await connection.disconnect();
        await persistence.drainHocuspocusPersistence();
      }
    });
  }
});
