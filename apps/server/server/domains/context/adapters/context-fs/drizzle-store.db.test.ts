/**
 * ContextFS over Postgres: a move or rename is a record of the project's list, and a write
 * overlapping it keeps one document identity.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - alias-only rename no-ops (kb/wiki/architecture/documents/placement-and-naming.md#a-document-has-one-canonical-name)
 */
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { contextSources, documents, projects, treeNodes, users } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { Ok } from "../../../../shared/result.js";
import {
  deleteDrizzleRows,
  useRollbackTestDatabase,
} from "../../../../test-support/drizzle-reset.js";
import { moveInScope } from "../../../../test-support/entry-ref.js";
import { treeSeeder } from "../../../../test-support/tree-seed.js";
import { createDrizzleJournal } from "../../../collab/adapters/drizzle-journal.js";
import type { BindMarkdownInput } from "../../../collab/index.js";
import { fakeBoundWrite } from "../../../collab/test-support/bound-writes.js";
import { createTestDocumentLinkScopes } from "../../../collab/test-support/document-link-scopes.js";
import { createDrizzleTreeListStore } from "../drizzle-tree-list-store.js";
import { ContextFS } from "./context-fs.js";
import { DrizzleContextDocumentStore } from "./drizzle-store.js";
import { createSourceTree } from "./tree-writes.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("ContextFS Drizzle persistence (postgres)", () => {});
} else {
  describe("ContextFS Drizzle persistence (postgres)", () => {
    const USER_ID = "00000000-0000-4000-8000-000000000701";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000702";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000703";

    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
    });
    let db = database.current;

    beforeEach(async () => {
      db = database.current;
      await db.insert(users).values(conformanceUserValues(USER_ID, "contextfs-dispatch"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "ContextFS Dispatch Project",
        slug: "contextfs-dispatch-project",
      });
      await db.insert(contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
      });
    });

    function createContextHarness() {
      const store = new DrizzleContextDocumentStore({ db, contextSourceId: SOURCE_ID });
      const treeLists = createDrizzleTreeListStore({ db, journal: createDrizzleJournal(db) });
      const markdownByDocument = new Map<string, string>();
      let beforeCollabWrite: (() => Promise<void>) | null = null;
      const context = new ContextFS({
        placement: { kind: "live" },
        holder: { projectId: PROJECT_ID },
        links: createTestDocumentLinkScopes(db),
        store,
        writes: createSourceTree({ store: treeLists, db, sourceId: async () => SOURCE_ID }),
        actor: `user:${USER_ID}`,
        scheme: "kb",
        documentSync: {
          readAsMarkdown: async (documentId: string) =>
            Ok(markdownByDocument.get(documentId) ?? ""),
          bindMarkdown: async (input: BindMarkdownInput) => fakeBoundWrite(input),
          seedFromMarkdown: async (documentId: string, { markdown }: { markdown: string }) => {
            await beforeCollabWrite?.();
            markdownByDocument.set(documentId, markdown);
            // This sync fake supplies the collab-owned projection effect.
            await db
              .update(documents)
              .set({ sizeBytes: Buffer.byteLength(markdown, "utf8"), updatedAt: new Date() })
              .where(eq(documents.id, documentId));
            return Ok({ updateSeq: 1 });
          },
        } as never,
      });
      const seeds = treeSeeder(db);
      return {
        context,
        seeds,
        pauseNextWrite: (hook: () => Promise<void>) => {
          beforeCollabWrite = async () => {
            beforeCollabWrite = null;
            await hook();
          };
        },
        /** A rename or move to `destination`, as the records a tree command makes. */
        move: (nodeId: string, destination: string) => {
          const parts = destination.split("/");
          return context.tree.command({
            make: (scope) => ({
              result: undefined,
              arrived: moveInScope(scope, nodeId, parts.slice(0, -1), parts.at(-1)).arrived,
            }),
          });
        },
      };
    }

    const treeRows = () =>
      db
        .select({
          id: treeNodes.id,
          name: treeNodes.name,
          extension: treeNodes.extension,
          fileType: treeNodes.fileType,
        })
        .from(treeNodes)
        .where(eq(treeNodes.kind, "document"));

    it("keeps one document identity when a write and a rename overlap", async () => {
      const { context, move, pauseNextWrite, seeds } = createContextHarness();
      const chapter = await seeds.document(SOURCE_ID, "chapter");
      let releaseWrite = () => {};
      const writeReleased = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      let markWriteStarted = () => {};
      const writeStarted = new Promise<void>((resolve) => {
        markWriteStarted = resolve;
      });
      pauseNextWrite(async () => {
        markWriteStarted();
        await writeReleased;
      });

      const write = context.write("chapter", "Revised chapter");
      await writeStarted;
      // The rename waits for the write's document key, then lands after it.
      const renamed = move(chapter, "renamed chapter.txt");
      releaseWrite();
      await expect(renamed).resolves.toMatchObject({ ok: true });

      await expect(write).resolves.toMatchObject({ ok: true, value: { documentId: chapter } });
      await expect(treeRows()).resolves.toEqual([
        { id: chapter, name: "renamed chapter", extension: "", fileType: "markdown" },
      ]);
      await expect(context.stat("chapter")).resolves.toEqual({ ok: true, value: null });
      await expect(context.read("renamed chapter")).resolves.toMatchObject({
        ok: true,
        value: { content: "Revised chapter" },
      });
    });

    it("keeps an alias-only rename in place", async () => {
      const { context, move, seeds } = createContextHarness();
      const alias = await seeds.document(SOURCE_ID, "Alias");
      expect(await move(alias, "Alias.txt")).toMatchObject({ ok: true });
      expect(await treeRows()).toEqual([
        { id: alias, name: "Alias", extension: "", fileType: "markdown" },
      ]);
      expect(await context.read("Alias.md")).toMatchObject({ ok: true });
    });
  });
}
