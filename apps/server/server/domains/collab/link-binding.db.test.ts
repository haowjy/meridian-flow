/**
 * Whole-document write doors bind outside their transaction and apply bound
 * content inside it (contract §6.2, ledger A2-1).
 */
import { randomUUID } from "node:crypto";
import { Hocuspocus } from "@hocuspocus/server";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  linkAheadRefs,
  modelResponses,
  projects,
  threads,
  threadWorks,
  turns,
  users,
  works,
} from "@meridian/database/schema";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { composeAppServices, createProductionAppPorts } from "../../lib/compose.js";
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { runWithEditConfirmation } from "../../shared/edit-confirmation.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import { createNoopEventSink } from "../observability/index.js";
import { createDrizzleJournal } from "./adapters/drizzle-journal.js";
import { LinkBindingInsideTransactionError } from "./domain/link-binding.js";
import { extractStoredLinks } from "./domain/stored-link-extraction.js";

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

    /** Stored refs in document order, read from the journal (what every reader spells from). */
    async function storedRefs(documentId: string): Promise<(string | null)[]> {
      const snapshot = await createDrizzleJournal(db).read(documentId);
      const doc = new Y.Doc({ gc: false });
      if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
      for (const row of snapshot.updates) Y.applyUpdate(doc, row.update);
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

    it("binds before the transaction: refs survive append, import is fresh, the guard holds", async () => {
      await deleteDrizzleRows(db, [users]);
      const userId = randomUUID();
      const projectId = randomUUID();
      await db.insert(users).values(conformanceUserValues(userId, "link-binding"));
      await db.insert(projects).values({ id: projectId, userId, name: "Binding", slug: "binding" });
      await db
        .insert(works)
        .values({ projectId, createdByUserId: userId, name: "No Work", isNoWork: true });
      await db.insert(contextSources).values({
        projectId,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        isPrimary: true,
      });
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
      const port = app.contextPorts.forProject(projectId, userId, new Map());
      const writer = { origin: { type: "human" as const, userId } };
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
          expected: (refs: (string | null)[]) => unknown;
        }[] = [
          {
            door: "writer overwrite binds a resolved link and mints one ahead",
            act: async () => {
              await ok(
                port.write("manuscript://holder.md", "[T](target.md) and [S](soon.md).", writer),
              );
              return holder;
            },
            expected: (refs) => {
              soon = refs[1] ?? null;
              return [targetRef, expect.stringMatching(/^ahead:/)];
            },
          },
          {
            door: "host append, after the target moved, keeps every existing ref verbatim",
            act: async () => {
              await ok(port.move("manuscript://target.md", "manuscript://moved/target.md"));
              await ok(
                port.edit(
                  "manuscript://holder.md",
                  { kind: "append", content: "\n\n[L](later.md)" },
                  writer,
                ),
              );
              return holder;
            },
            expected: () => [targetRef, soon, expect.stringMatching(/^ahead:/)],
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
            expected: () => [targetRef, expect.not.stringMatching(soon ?? "")],
          },
          {
            door: "create with content (upload) binds before its transaction",
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
            expected: () => [expect.stringMatching(/^ahead:/)],
          },
        ];

        for (const { door, act, expected } of doors) {
          const refs = await storedRefs(await act());
          expect(refs, door).toEqual(expected(refs));
          for (const ref of refs.filter((each) => each?.startsWith("ahead:"))) {
            expect(await registeredAddress(ref), door).toMatch(new RegExp(` in ${projectId}$`));
          }
        }
        expect(await registeredAddress(soon)).toBe(`manuscript://soon.md in ${projectId}`);

        // A door that forgot to hoist fails at once instead of waiting on its own locks.
        await expect(
          runInDrizzleTransaction(db, () =>
            ports.documentSync.bindMarkdown({
              holder: { documentId: holder as never },
              markdown: "[N](new.md)",
            }),
          ),
        ).rejects.toBeInstanceOf(LinkBindingInsideTransactionError);
      } finally {
        await app.shutdown();
      }
    });

    it("an agent's whole-document write binds to the links its thread was shown", async () => {
      await deleteDrizzleRows(db, [users]);
      const userId = randomUUID();
      const projectId = randomUUID();
      const threadId = randomUUID();
      const turnId = randomUUID();
      await db.insert(users).values(conformanceUserValues(userId, "link-binding-shown"));
      await db.insert(projects).values({ id: projectId, userId, name: "Shown", slug: "shown" });
      const [noWork] = await db
        .insert(works)
        .values({ projectId, createdByUserId: userId, name: "No Work", isNoWork: true })
        .returning();
      await db.insert(contextSources).values({
        projectId,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        isPrimary: true,
      });
      await db.insert(threads).values({
        id: threadId,
        rootThreadId: threadId,
        projectId,
        createdByUserId: userId,
        title: "Thread",
        kind: "primary",
        status: "idle",
      });
      await db.insert(turns).values({
        id: turnId,
        threadId,
        position: 1,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      await db.insert(modelResponses).values({
        id: turnId,
        turnId,
        sequence: 1,
        provider: "fixture",
        model: "fixture",
        requestMessageCount: 1,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
      });
      await db
        .insert(threadWorks)
        .values({ threadId, workId: noWork?.id ?? "", projectId, isPrimary: true });
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
      const port = app.contextPorts.forProject(projectId, userId, new Map());
      const ok = async <T>(
        result: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>,
      ) => {
        const settled = await result;
        if (!settled.ok) throw new Error(JSON.stringify(settled.error));
        return settled.value;
      };

      try {
        const target = (await ok(port.createTrackedDocument("manuscript://target.md", "")))
          .documentId;
        const holder = (await ok(port.createTrackedDocument("manuscript://holder.md", "")))
          .documentId;
        // The thread was shown the target at its old address; then the target moved.
        await ports.shownLinks.record({
          threadId,
          turnId,
          documentId: holder,
          holderUri: "manuscript://holder.md",
          view: { kind: "live" },
          links: [{ ref: `doc:${target}`, address: "manuscript://target.md" }],
        });
        await ok(port.move("manuscript://target.md", "manuscript://moved/target.md"));

        // Spelled as shown, the link names the document shown, not a fresh ahead address.
        const agent = { type: "agent" as const, agentSlug: "writer", threadId, turnId };
        // An agent write reaches the seam with its grant bound, as the tool path binds it.
        const granted = { workIds: [], confirm: async () => {}, covers: async () => true };
        await runWithEditConfirmation(granted, () =>
          ok(port.write("manuscript://holder.md", "[T](target.md)", { origin: agent })),
        );
        expect(await storedRefs(holder)).toEqual([`doc:${target}`]);
      } finally {
        await app.shutdown();
      }
    });
  },
);
