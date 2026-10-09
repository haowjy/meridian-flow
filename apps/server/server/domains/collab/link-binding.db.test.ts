/**
 * Whole-document write doors bind outside their transaction and apply the
 * bound write inside it (contract §6.2, ledger A2-1): desired state, applied
 * as the ordinary overwrite and certified for one holder.
 */
import { createHash, randomUUID } from "node:crypto";
import { Hocuspocus } from "@hocuspocus/server";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  linkAheadRefs,
  projects,
  threads,
  threadWorks,
  users,
  works,
} from "@meridian/database/schema";
import { extractStoredLinks } from "@meridian/markup";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { composeAppServices, createProductionAppPorts } from "../../lib/compose.js";
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import { createNoopEventSink } from "../observability/index.js";
import { createDrizzleJournal } from "./adapters/drizzle-journal.js";
import { LinkBindingInsideTransactionError } from "./domain/link-binding.js";
import { materializeRootLineageForDoc } from "./domain/provenance.js";

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

    /** The document as its journal holds it (what every reader spells from). */
    async function journalDoc(documentId: string): Promise<Y.Doc> {
      const snapshot = await createDrizzleJournal(db).read(documentId);
      const doc = new Y.Doc({ gc: false });
      if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
      for (const row of snapshot.updates) Y.applyUpdate(doc, row.update);
      return doc;
    }
    /** Stored refs in document order. */
    async function storedRefs(documentId: string): Promise<(string | null)[]> {
      const doc = await journalDoc(documentId);
      const refs = extractStoredLinks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)).map(
        (occurrence) => occurrence.ref,
      );
      doc.destroy();
      return refs;
    }
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
      const [source] = await db
        .insert(contextSources)
        .values({
          projectId,
          name: "Manuscript",
          slug: "manuscript",
          scope: "project",
          isPrimary: true,
        })
        .returning();
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
        environment: { OPENAI_API_KEY: "sk-test-link-binding" },
      });
      const app = composeAppServices(ports);
      ports.documentSync.bindHocuspocus(
        new Hocuspocus({
          yDocOptions: { gc: false, gcFilter: () => true },
          onStoreDocument: ({ documentName, document }) =>
            ports.documentSync.storeHocuspocusDocument(documentName, document),
        }),
      );
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
      /** The text of the document's `index`th block. */
      const blockText = (fragment: Y.XmlFragment, index: number) =>
        (fragment.get(index) as Y.XmlElement).get(0) as Y.XmlText;
      /**
       * An independent writer's edit, made from the document as it is now
       * (by default: new prose, link removed); admitting it is returned.
       */
      const writerEdit = async (
        documentId: string,
        edit = (fragment: Y.XmlFragment) => {
          const prose = blockText(fragment, 0);
          prose.delete(0, prose.length);
          prose.insert(0, "Concurrent.");
          const linked = blockText(fragment, 1);
          linked.format(0, linked.length, { link: null });
        },
      ) => {
        const client = new Y.Doc({ gc: false });
        const state = await ports.documentSync.loadHocuspocusDocument?.(documentId);
        if (state) Y.applyUpdate(client, state);
        const vector = Y.encodeStateVector(client);
        client.transact(() => edit(client.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)));
        const update = Y.encodeStateAsUpdate(client, vector);
        client.destroy();
        return async () => {
          const journal = createDrizzleJournal(db);
          const snapshot = await journal.read(documentId);
          if (!snapshot.authority || !journal.appendWriterUpdate) throw new Error("No writer path");
          await journal.appendWriterUpdate(
            documentId,
            update,
            { origin: `human:${userId}`, seq: 0 },
            snapshot.authority,
          );
          await ports.documentSync.readAsMarkdown(documentId);
        };
      };

      try {
        const target = (await ok(port.createTrackedDocument("manuscript://target.md", "")))
          .documentId;
        const holder = (await ok(port.createTrackedDocument("manuscript://holder.md", "")))
          .documentId;
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
              await ok(
                port.write("manuscript://holder.md", "[T](target.md) and [S](soon.md).", writer),
              );
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
              await ok(port.move("manuscript://target.md", "manuscript://moved/target.md"));
              await ok(
                port.write(
                  "manuscript://holder.md",
                  "[T](moved/target.md) and [S](soon.md).\n\n[L](later.md)",
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
                  port.write(
                    "manuscript://imported.md",
                    "[T](moved/target.md) and [S](soon.md).",
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
                  port.createTrackedDocument(
                    "manuscript://uploaded.md",
                    "[U](unwritten.md)",
                    imported,
                  ),
                )
              ).documentId,
            refs: () => [expect.stringMatching(/^ahead:/)],
          },
          {
            door: "an upload binds before finalize's transaction and persists under its locks",
            act: async () => {
              const bytes = new TextEncoder().encode("# Upload\n\n[Ahead](manuscript://future.md)");
              const uploaded = await app.uploadIntake.intake({
                intakeId: randomUUID(),
                actorUserId: userId,
                owner: { kind: "work", projectId, workId: noWorkId },
                filename: "upload.md",
                mimeType: "text/markdown",
                bytes,
                byteDigest: createHash("sha256").update(bytes).digest("hex"),
              });
              if (!uploaded.ok) throw new Error(uploaded.error.code);
              return uploaded.value.documentId;
            },
            refs: () => [expect.stringMatching(/^ahead:/)],
            markdown: "# Upload\n\n[Ahead](manuscript://future.md)\n",
          },
          ...[writer, writerInThread].flatMap((actor) =>
            (["before", "after"] as const).map((when) => ({
              // Desired state: an edit admitted before the save applies is replaced; one made
              // against the old state and admitted after merges into the blocks the save kept.
              door: `a save and a writer's edit and unlink admitted ${when} it applies${"threadId" in actor.origin ? " (in a thread)" : ""}`,
              act: async () => {
                const uri = `manuscript://merge-${when}-${"threadId" in actor.origin}.md`;
                const id = (await ok(port.createTrackedDocument(uri, "Original.\n\n[T](c.md)")))
                  .documentId;
                const edit = await writerEdit(id);
                if (when === "before") afterNextBind = edit;
                await ok(port.write(uri, "Original.\n\n[T](c.md)\n\nAppend.", actor));
                if (when === "after") await edit();
                return id;
              },
              refs: () => (when === "after" ? [] : [expect.stringMatching(/^ahead:/)]),
              markdown:
                when === "after"
                  ? "Concurrent.\n\nT\n\nAppend.\n"
                  : "Original.\n\n[T](c.md)\n\nAppend.\n",
            })),
          ),
          {
            door: "a save in a thread is the overwrite agent-edit certifies: prose it kept keeps its roots",
            act: async () => {
              const uri = "manuscript://certified.md";
              const id = (
                await ok(
                  port.createTrackedDocument(uri, "First para.\n\nSecond para here.\n\nThird."),
                )
              ).documentId;
              const base = await journalDoc(id);
              const baseVector = Y.decodeStateVector(Y.encodeStateVector(base));
              base.destroy();
              await ok(
                port.write(
                  uri,
                  "Inserted.\n\nFirst para.\n\nSecond para changed here.\n\nThird.",
                  writerInThread,
                ),
              );
              // Only the new paragraph and word are the saver's; every paragraph the save kept
              // keeps its items, and so the authorship it had.
              const saved = await journalDoc(id);
              const freshUnits = materializeRootLineageForDoc(saved)
                .filter(({ root }) => root.clock >= (baseVector.get(root.clientID) ?? 0))
                .reduce((sum, { root }) => sum + root.length, 0);
              saved.destroy();
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
                const uri = `manuscript://kept-middle-${when}-${"threadId" in actor.origin}.md`;
                const id = (
                  await ok(port.createTrackedDocument(uri, "Alpha.\n\nBravo.\n\nCharlie."))
                ).documentId;
                const base = await journalDoc(id);
                const kept = base.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(1) as Y.XmlElement;
                const keptText = kept.get(0) as Y.XmlText;
                const keptIds = [kept._item?.id, keptText._item?.id];
                const anchor = Y.createRelativePositionFromTypeIndex(keptText, 3);
                base.destroy();
                const edit = await writerEdit(id, (fragment) => {
                  const text = blockText(fragment, 1);
                  text.insert(text.length, " Concurrent.");
                });
                if (when === "before") afterNextBind = edit;
                await ok(
                  port.write(uri, "Alpha.\n\nInserted.\n\nBravo.\n\nChanged Charlie.", actor),
                );
                if (when === "after") await edit();
                const saved = await journalDoc(id);
                const block = saved
                  .getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)
                  .get(2) as Y.XmlElement;
                const text = block.get(0) as Y.XmlText;
                expect([block._item?.id, text._item?.id]).toEqual(keptIds);
                const resolved = Y.createAbsolutePositionFromRelativePosition(anchor, saved);
                expect(resolved?.type).toBe(text);
                expect(resolved?.index).toBe(3);
                saved.destroy();
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
                await ok(
                  port.createTrackedDocument("manuscript://occupant.md", "First.\n\n[A](a.md)"),
                )
              ).documentId;
              afterNextBind = async () => {
                await ok(port.move("manuscript://occupant.md", "manuscript://first-moved.md"));
                await ok(port.createTrackedDocument("manuscript://occupant.md", "Second."));
              };
              const saved = await port.write(
                "manuscript://occupant.md",
                "First.\n\nAppend.",
                writer,
              );
              expect(saved).toMatchObject({ ok: false, error: { code: "stale_target" } });
              expect(await read("manuscript://first-moved.md")).toBe("First.\n\n[A](a.md)\n");
              expect(await read("manuscript://occupant.md")).toBe("Second.\n");
              return first;
            },
            refs: () => [expect.stringMatching(/^ahead:/)],
            markdown: "First.\n\n[A](a.md)\n",
          },
          {
            door: "repair never publishes an empty document over a projection with no canonical state",
            act: async () => {
              const half = randomUUID();
              const surviving = "Only surviving prose.\n\n[T](target.md)";
              await db.insert(documents).values({
                id: half,
                contextSourceId: source?.id ?? "",
                name: "half",
                extension: "md",
                markdownProjection: surviving,
              });
              const repaired = await port.ensureTrackedDocument("manuscript://half.md");
              expect(repaired).toMatchObject({ ok: false, error: { code: "io_error" } });
              const [kept] = await db.select().from(documents).where(eq(documents.id, half));
              expect(kept?.markdownProjection).toBe(surviving);
              expect((await createDrizzleJournal(db).read(half)).checkpoint).toBeFalsy();
              return half;
            },
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
            const refs = await storedRefs(documentId);
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
        expect(await registeredAddress(soon)).toBe(`manuscript://soon.md in ${projectId}`);

        // A door that forgot to hoist fails at once instead of waiting on its own locks.
        await expect(
          runInDrizzleTransaction(db, () =>
            bindMarkdown({
              holder: { documentId: holder as never },
              markdown: "[N](new.md)",
            }),
          ),
        ).rejects.toBeInstanceOf(LinkBindingInsideTransactionError);
      } finally {
        await app.shutdown();
      }
    });
  },
);
