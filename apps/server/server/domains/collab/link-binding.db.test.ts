/**
 * Whole-document write doors bind outside their transaction and apply the
 * bound write inside it (contract §6.2, ledger A2-1): desired state, applied
 * as the ordinary overwrite and certified for one holder.
 */

import { randomUUID } from "node:crypto";
import { LoroDocument, loroModel, toLoroHandle } from "@meridian/agent-edit/integration";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  linkAheadRefs,
  projects,
  threads,
  threadWorks,
  users,
  works,
} from "@meridian/database/schema";
import {
  applyOps,
  type BlockId,
  encodeEnvelope,
  freshPeerId,
  type RoomDocs,
  readDocument,
  type ShapeBlock,
  type ShapeOp,
  TEXT_KEY,
} from "@meridian/document-model";
import { walkLinkOccurrences } from "@meridian/markup/links";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { Cursor, type VersionVector } from "loro-crdt";
import { afterAll, describe, expect, it } from "vitest";
import { composeAppServices, createProductionAppPorts } from "../../lib/compose.js";
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import { entryAt, moveTo } from "../../test-support/entry-ref.js";
import { uploadBytes } from "../context/uploads/upload-test-support.js";
import { createNoopEventSink } from "../observability/index.js";
import { LinkBindingInsideTransactionError } from "./domain/link-binding.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
describe.skipIf(!enabled || !process.env.DATABASE_URL)(
  "whole-document link binding (postgres)",
  () => {
    // Registration commits in its own root transaction: committed-data isolation, reset by FK order.
    const db = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 6 });
    afterAll(async () => {
      await deleteDrizzleRows(db, [users]);
      await db.close();
    });

    const schema = buildDocumentSchema();
    const model = loroModel(schema);
    /** Stored refs in document order, as the Live room holds them. */
    const storedRefs = (rooms: Rooms, documentId: string) =>
      withLive(rooms, documentId, (docs) =>
        walkLinkOccurrences(
          model
            .projectBlocks(toLoroHandle(new LoroDocument(docs, schema)))
            .map((block) => block.node),
        ).map(({ attrs }) => attrs.ref),
      );
    async function registeredAddress(ref: string | null) {
      const aheadId = ref?.startsWith("ahead:") ? ref.slice("ahead:".length) : null;
      if (!aheadId) return null;
      const [row] = await db.select().from(linkAheadRefs).where(eq(linkAheadRefs.aheadId, aheadId));
      return row ? `${row.scheme}://${row.path} in ${row.projectId}` : null;
    }

    it("binds before the transaction: refs survive, saves are desired state, holders are certified", async () => {
      await deleteDrizzleRows(db, [users]);
      const userId = randomUUID();
      const projectId = randomUUID();
      const threadId = randomUUID();
      await db.insert(users).values(conformanceUserValues(userId, "link-binding"));
      await db.insert(projects).values({ id: projectId, userId, name: "Binding", slug: "binding" });
      const [noWork] = await db
        .insert(works)
        .values({ projectId, createdByUserId: userId, name: "No Work", isNoWork: true })
        .returning();
      const noWorkId = noWork?.id ?? "";
      await db.insert(contextSources).values({
        projectId,
        slug: "manuscript",
        scope: "project",
      });
      await db.insert(threads).values({
        id: threadId,
        rootThreadId: threadId,
        projectId,
        createdByUserId: userId,
      });
      await db
        .insert(threadWorks)
        .values({ threadId, workId: noWorkId, projectId, isPrimary: true });
      const ports = await createProductionAppPorts({
        db,
        eventSink: createNoopEventSink(),
        environment: { FLOW_OPENAI_API_KEY: "sk-test-link-binding" },
      });
      const app = composeAppServices(ports);
      const { rooms } = ports.documentSync;
      // Runs once, after the next whole-document write is bound and before it applies.
      let afterNextBind: (() => Promise<void>) | null = null;
      const bindMarkdown = ports.documentSync.bindMarkdown;
      ports.documentSync.bindMarkdown = async (input) => {
        const bound = await bindMarkdown(input);
        const between = afterNextBind;
        afterNextBind = null;
        await between?.();
        return bound;
      };
      const port = app.contextPorts.forProject(projectId, userId, new Map());
      const writer = { origin: { type: "human" as const, userId } };
      const writerInThread = { origin: { type: "human" as const, userId, threadId } };
      const imported = {
        origin: { type: "import" as const, userId, source: "upload", filename: "notes.md" },
      };
      const ok = async <T>(
        result: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>,
      ) => {
        const settled = await result;
        if (!settled.ok) throw new Error(JSON.stringify(settled.error));
        return settled.value;
      };
      const read = async (uri: string) => (await ok(port.read(uri))).content;
      /**
       * An independent writer's edit, made from the document as it is now
       * (by default: new prose, link removed); admitting it is returned.
       */
      const writerEdit = async (
        documentId: string,
        edit = (top: readonly ShapeBlock[]): ShapeOp[] => [
          {
            kind: "text",
            block: idAt(top, 0),
            splices: [whole(top, 0, "Concurrent.")],
            formats: [],
          },
          {
            kind: "text",
            block: idAt(top, 1),
            splices: [],
            formats: [{ from: 0, to: lengthAt(top, 1), mark: "link", value: null }],
          },
        ],
      ) => {
        const room = { kind: "live", documentId } as const;
        const tab = await rooms.read(room, { peer: freshPeerId() });
        let batch: Uint8Array;
        try {
          const before = tab.version();
          const applied = applyOps(tab, edit(readDocument(tab)));
          if (!applied.ok) throw new Error(applied.message);
          batch = encodeEnvelope(tab.exportSince(before));
        } finally {
          tab.free();
        }
        return async () => {
          await rooms.write(room, batch, "test:tab");
          await ports.documentSync.readAsMarkdown(documentId);
        };
      };

      try {
        const target = (await ok(port.createTrackedDocument("manuscript://target", ""))).documentId;
        const holder = (await ok(port.createTrackedDocument("manuscript://holder", ""))).documentId;
        const targetRef = `doc:${target}`;
        let soon: string | null = null;

        // Each door registers any ahead ref it mints. The registry refuses to run inside a
        // transaction, so a row only exists if the door bound before opening its own.
        const doors: {
          door: string;
          act: () => Promise<string>;
          refs?: (refs: (string | null)[]) => unknown;
          markdown?: string;
        }[] = [
          {
            door: "writer overwrite binds a resolved link and mints one ahead",
            act: async () => {
              await ok(port.write("manuscript://holder", "[T](target) and [S](soon).", writer));
              return holder;
            },
            refs: (refs) => {
              soon = refs[1] ?? null;
              return [targetRef, expect.stringMatching(/^ahead:/)];
            },
          },
          {
            door: "an overwrite after the target moved keeps every ref it leaves in place",
            act: async () => {
              await ok(
                moveTo(port, "manuscript://target", "manuscript://moved/target", {
                  expected: await entryAt(port, "manuscript://target"),
                }),
              );
              await ok(
                port.write(
                  "manuscript://holder",
                  "[T](moved/target) and [S](soon).\n\n[L](later)",
                  writer,
                ),
              );
              return holder;
            },
            refs: () => [targetRef, soon, expect.stringMatching(/^ahead:/)],
          },
          {
            door: "import binds fresh: it resolves the moved target and mints its own ahead ref",
            act: async () =>
              (
                await ok(
                  port.createTrackedDocument(
                    "manuscript://imported",
                    "[T](moved/target) and [S](soon).",
                    imported,
                  ),
                )
              ).documentId ?? "",
            refs: () => [targetRef, expect.not.stringMatching(soon ?? "")],
          },
          {
            door: "create with content binds before its transaction",
            act: async () =>
              (
                await ok(
                  port.createTrackedDocument("manuscript://uploaded", "[U](unwritten)", imported),
                )
              ).documentId,
            refs: () => [expect.stringMatching(/^ahead:/)],
          },
          {
            door: "an upload binds before finalize's transaction and persists under its locks",
            act: async () => {
              const bytes = new TextEncoder().encode("# Upload\n\n[Ahead](manuscript://future)");
              const uploaded = await uploadBytes(app.uploadIntake, app.objectStore, {
                actorUserId: userId,
                projectId,
                chatId: randomUUID(),
                filename: "upload.md",
                mimeType: "text/markdown",
                bytes,
              });
              if (!uploaded.ok) throw new Error(uploaded.error.code);
              return uploaded.value.documentId;
            },
            refs: () => [expect.stringMatching(/^ahead:/)],
            markdown: "# Upload\n\n[Ahead](manuscript://future)\n",
          },
          ...[writer, writerInThread].flatMap((actor) =>
            (["before", "after"] as const).map((when) => ({
              // Desired state: an edit admitted before the save applies is replaced; one made
              // against the old state and admitted after merges into the blocks the save kept.
              door: `a save and a writer's edit and unlink admitted ${when} it applies${"threadId" in actor.origin ? " (in a thread)" : ""}`,
              act: async () => {
                const uri = `manuscript://merge-${when}-${"threadId" in actor.origin}`;
                const id = (await ok(port.createTrackedDocument(uri, "Original.\n\n[T](c)")))
                  .documentId;
                const edit = await writerEdit(id);
                if (when === "before") afterNextBind = edit;
                await ok(port.write(uri, "Original.\n\n[T](c)\n\nAppend.", actor));
                if (when === "after") await edit();
                return id;
              },
              refs: () => (when === "after" ? [] : [expect.stringMatching(/^ahead:/)]),
              markdown:
                when === "after"
                  ? "Concurrent.\n\nT\n\nAppend.\n"
                  : "Original.\n\n[T](c)\n\nAppend.\n",
            })),
          ),
          {
            door: "a save in a thread is the overwrite agent-edit certifies: prose it kept keeps its roots",
            act: async () => {
              const uri = "manuscript://certified";
              const id = (
                await ok(
                  port.createTrackedDocument(uri, "First para.\n\nSecond para here.\n\nThird."),
                )
              ).documentId;
              const base = await withLive(rooms, id, textVersions);
              await ok(
                port.write(
                  uri,
                  "Inserted.\n\nFirst para.\n\nSecond para changed here.\n\nThird.",
                  writerInThread,
                ),
              );
              // Only the new paragraph and word are the saver's; every paragraph the save kept
              // keeps its items, and so the authorship it had.
              const saved = await withLive(rooms, id, textVersions);
              const freshUnits = [...saved].reduce(
                (sum, [key, version]) => sum + opsBeyond(version, base.get(key)),
                0,
              );
              expect(freshUnits).toBe("Inserted.".length + " changed".length);
              return id;
            },
            refs: () => [],
            markdown: "Inserted.\n\nFirst para.\n\nSecond para changed here.\n\nThird.\n",
          },
          // A2-R1: a save is an ordered block correspondence against the document, not a
          // positional diff, so a kept paragraph between changed ones stays itself.
          ...[writer, writerInThread].flatMap((actor) =>
            (["before", "after"] as const).map((when) => ({
              door: `a save inserting above a kept paragraph keeps its items, anchors, and an edit to it admitted ${when} the save${"threadId" in actor.origin ? " (in a thread)" : ""}`,
              act: async () => {
                const uri = `manuscript://kept-middle-${when}-${"threadId" in actor.origin}`;
                const id = (
                  await ok(port.createTrackedDocument(uri, "Alpha.\n\nBravo.\n\nCharlie."))
                ).documentId;
                const { kept, anchor } = await withLive(rooms, id, (docs) => {
                  const block = idAt(readDocument(docs), 1);
                  const cursor = docs.textOf(block)?.getText(TEXT_KEY).getCursor(3);
                  if (!cursor) throw new Error("no cursor in the kept paragraph");
                  return { kept: block, anchor: cursor.encode() };
                });
                const edit = await writerEdit(id, (top) => [
                  {
                    kind: "text",
                    block: idAt(top, 1),
                    splices: [
                      {
                        from: lengthAt(top, 1),
                        to: lengthAt(top, 1),
                        content: [{ kind: "text", text: " Concurrent.", marks: {} }],
                      },
                    ],
                    formats: [],
                  },
                ]);
                if (when === "before") afterNextBind = edit;
                await ok(
                  port.write(uri, "Alpha.\n\nInserted.\n\nBravo.\n\nChanged Charlie.", actor),
                );
                if (when === "after") await edit();
                await withLive(rooms, id, (docs) => {
                  expect(idAt(readDocument(docs), 2)).toBe(kept);
                  const cursor = Cursor.decode(anchor);
                  try {
                    expect(docs.textOf(kept)?.getCursorPos(cursor)?.offset).toBe(3);
                  } finally {
                    cursor.free();
                  }
                });
                return id;
              },
              refs: () => [],
              markdown: `Alpha.\n\nInserted.\n\nBravo.${when === "after" ? " Concurrent." : ""}\n\nChanged Charlie.\n`,
            })),
          ),
          {
            door: "a write bound for one holder never lands on the document that replaced it",
            act: async () => {
              const first = (
                await ok(port.createTrackedDocument("manuscript://occupant", "First.\n\n[A](a)"))
              ).documentId;
              afterNextBind = async () => {
                await ok(
                  moveTo(port, "manuscript://occupant", "manuscript://first-moved", {
                    expected: await entryAt(port, "manuscript://occupant"),
                  }),
                );
                await ok(port.createTrackedDocument("manuscript://occupant", "Second."));
              };
              const saved = await port.write("manuscript://occupant", "First.\n\nAppend.", writer);
              expect(saved).toMatchObject({ ok: false, error: { code: "stale_target" } });
              expect(await read("manuscript://first-moved")).toBe("First.\n\n[A](a)\n");
              expect(await read("manuscript://occupant")).toBe("Second.\n");
              return first;
            },
            refs: () => [expect.stringMatching(/^ahead:/)],
            markdown: "First.\n\n[A](a)\n",
          },
          {
            door: "a new code file is created with its content, as code",
            act: async () =>
              (
                await ok(
                  port.createTrackedDocument("manuscript://new.ts", 'const x = "[T](a.md)";'),
                )
              ).documentId,
            refs: () => [],
            markdown: 'const x = "[T](a.md)";',
          },
        ];

        // Every door runs and reports; later doors build on earlier ones' documents.
        const failures: string[] = [];
        for (const { door, act, refs: expectedRefs, markdown } of doors) {
          try {
            const documentId = await act();
            const refs = await storedRefs(rooms, documentId);
            if (expectedRefs) expect(refs, door).toEqual(expectedRefs(refs));
            if (markdown !== undefined) {
              const content = await ports.documentSync.readAsMarkdown(documentId);
              expect(content, door).toEqual({ ok: true, value: markdown });
            }
            for (const ref of refs.filter((each) => each?.startsWith("ahead:"))) {
              expect(await registeredAddress(ref), door).toMatch(new RegExp(` in ${projectId}$`));
            }
          } catch (error) {
            failures.push(`${door}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        expect(failures).toEqual([]);
        expect(await registeredAddress(soon)).toBe(`manuscript://soon in ${projectId}`);

        // A door that forgot to hoist fails at once instead of waiting on its own locks.
        await expect(
          runInDrizzleTransaction(db, () =>
            bindMarkdown({
              holder: { documentId: holder as never },
              markdown: "[N](new)",
            }),
          ),
        ).rejects.toBeInstanceOf(LinkBindingInsideTransactionError);
      } finally {
        await app.shutdown();
      }
    });
  },
);

type Rooms = import("./contracts.js").CollabTransport["rooms"];

/** Runs `read` on a copy of the document's Live room, and frees the copy. */
async function withLive<T>(rooms: Rooms, documentId: string, read: (docs: RoomDocs) => T) {
  const docs = await rooms.read({ kind: "live", documentId });
  try {
    return read(docs);
  } finally {
    docs.free();
  }
}

const idAt = (top: readonly ShapeBlock[], index: number): BlockId => {
  const block = top[index];
  if (!block) throw new Error(`no block ${index}`);
  return block.id;
};

/** The units of a top-level textblock: its characters and inline nodes. */
const lengthAt = (top: readonly ShapeBlock[], index: number) => {
  const block = top[index];
  if (block?.kind !== "text") throw new Error(`block ${index} is not a textblock`);
  return block.inline.reduce((sum, item) => sum + (item.kind === "text" ? item.text.length : 1), 0);
};

const whole = (top: readonly ShapeBlock[], index: number, text: string) => ({
  from: 0,
  to: lengthAt(top, index),
  content: [{ kind: "text" as const, text, marks: {} }],
});

/** Each text doc's version, by block id. */
const textVersions = (docs: RoomDocs) =>
  new Map([...docs.texts].map(([key, doc]) => [key, doc.oplogVersion()]));

/** How many ops `version` holds that `base` does not. */
function opsBeyond(version: VersionVector, base: VersionVector | undefined): number {
  let count = 0;
  for (const [peer, counter] of version.toJSON()) count += counter - (base?.get(peer) ?? 0);
  return count;
}
