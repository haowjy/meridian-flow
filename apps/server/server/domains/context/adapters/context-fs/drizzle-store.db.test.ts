/**
 * ContextFS Drizzle persistence and atomic writer mutation coverage.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - rename-as-name-change rejection and alias-only rename no-ops (kb/decisions/collab/drafts/model/branch-created-documents-are-hidden-live.md)
 */
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { contextSources, documents, folders, projects, users } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { Ok } from "../../../../shared/result.js";
import { createTestDocumentRemoval } from "../../../../test-support/document-removal.js";
import {
  deleteDrizzleRows,
  useRollbackTestDatabase,
} from "../../../../test-support/drizzle-reset.js";
import type { BindMarkdownInput } from "../../../collab/index.js";
import { fakeBoundWrite } from "../../../collab/test-support/bound-writes.js";
import { createTestDocumentLinkScopes } from "../../../collab/test-support/document-link-scopes.js";
import { type ContextTreeDispatch, ContextTreeMover } from "../../context/context-tree-mover.js";
import { ContextFS } from "./context-fs.js";
import { DrizzleContextDocumentStore } from "./drizzle-store.js";
import { DrizzleContextTreeMutationStore } from "./drizzle-tree-mutation-store.js";

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
      const markdownByDocument = new Map<string, string>();
      const observedWriteFiletypes: Array<string | null> = [];
      let beforeCollabWrite: (() => Promise<void>) | null = null;
      const mutationStore = new DrizzleContextTreeMutationStore(db, {
        removal: createTestDocumentRemoval(db),
      });
      const context = new ContextFS({
        placement: { kind: "live" },
        holder: { projectId: PROJECT_ID },
        links: createTestDocumentLinkScopes(db),
        store,
        mutationStore,
        scheme: "kb",
        documentSync: {
          readAsMarkdown: async (documentId: string) =>
            Ok(markdownByDocument.get(documentId) ?? ""),
          bindMarkdown: async (input: BindMarkdownInput) => fakeBoundWrite(input),
          seedFromMarkdown: async (documentId: string, { markdown }: { markdown: string }) => {
            await beforeCollabWrite?.();
            const [row] = await db
              .select({ filetype: documents.fileType })
              .from(documents)
              .where(eq(documents.id, documentId));
            observedWriteFiletypes.push(row?.filetype ?? null);
            markdownByDocument.set(documentId, markdown);
            // This sync fake supplies the collab-owned projection effect.
            await db
              .update(documents)
              .set({
                sizeBytes: Buffer.byteLength(markdown, "utf8"),
                updatedAt: new Date(),
              })
              .where(eq(documents.id, documentId));
            return Ok({ updateSeq: 1 });
          },
        } as never,
      });
      const mover = new ContextTreeMover();
      const dispatch = (path: string): ContextTreeDispatch => ({
        adapter: context,
        scheme: "kb",
        workScopeId: null,
        path,
        canonical: `kb://${path}`,
      });
      return {
        context,
        mutationStore,
        observedWriteFiletypes,
        pauseNextWrite: (hook: () => Promise<void>) => {
          beforeCollabWrite = async () => {
            beforeCollabWrite = null;
            await hook();
          };
        },
        move: async (source: string, destination: string) => {
          const token = await context.tree.inspectMovable(source);
          if (!token.ok || !token.value) throw new Error(`Nothing to move at ${source}`);
          return mover.commitWriterLocation(
            {
              kind: token.value.kind === "directory" ? "folder" : "file",
              nodeId: token.value.nodeId,
            },
            dispatch(""),
            {
              destination: {
                kind: "at",
                folder: dispatch(destination.split("/").slice(0, -1).join("/")),
                createFolders: [],
              },
              name: destination.split("/").at(-1),
            },
          );
        },
      };
    }

    it("enforces cross-schema and tracked/storage rename rejection in Postgres", async () => {
      const { context, move } = createContextHarness();
      await context.createTrackedDocument("chapter", "Chapter");
      await context.createTrackedDocument("script.py", "print('hello')");
      await context.writeBinary("cover.png", {
        fileType: "image",
        storageUrl: "s3://bucket/cover.png",
        mimeType: "image/png",
        sizeBytes: 42,
      });

      await expect(move("chapter", "chapter.py")).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_operation", message: expect.stringMatching(/schema/i) },
      });
      await expect(move("script.py", "script.png")).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_operation", message: expect.stringMatching(/tracked|binary/i) },
      });
      await expect(move("cover.png", "cover.txt")).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_operation", message: expect.stringMatching(/storage|tracked/i) },
      });
      await expect(context.stat("chapter")).resolves.toMatchObject({ ok: true });
      await expect(context.stat("script.py")).resolves.toMatchObject({ ok: true });
      await expect(context.stat("cover.png")).resolves.toMatchObject({ ok: true });
    });

    it("keeps one Postgres document identity when write and rename overlap", async () => {
      const { context, move, pauseNextWrite } = createContextHarness();
      const initial = await context.createTrackedDocument("chapter", "Chapter");
      if (!initial.ok || !initial.value.documentId) throw new Error("initial write failed");
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
      await expect(move("chapter", "renamed chapter.txt")).resolves.toMatchObject({ ok: true });
      releaseWrite();

      await expect(write).resolves.toMatchObject({
        ok: true,
        value: { documentId: initial.value.documentId },
      });
      await expect(
        db
          .select({ id: documents.id, name: documents.name, extension: documents.extension })
          .from(documents),
      ).resolves.toEqual([
        { id: initial.value.documentId, name: "renamed chapter", extension: "" },
      ]);
      await expect(context.stat("renamed chapter")).resolves.toMatchObject({
        ok: true,
        value: { documentId: initial.value.documentId, filetype: "markdown", sizeBytes: 15 },
      });
      await expect(context.stat("chapter")).resolves.toEqual({ ok: true, value: null });
      await expect(context.read("renamed chapter")).resolves.toMatchObject({
        ok: true,
        value: { content: "Revised chapter" },
      });
    });

    it("keeps alias-only Postgres renames in place", async () => {
      const { context, move } = createContextHarness();
      const initial = await context.createTrackedDocument("Alias", "Unchanged");
      if (!initial.ok || !initial.value.documentId) throw new Error("initial write failed");
      expect(await move("Alias", "Alias.txt")).toMatchObject({ ok: true });
      expect(
        await db
          .select({ id: documents.id, name: documents.name, extension: documents.extension })
          .from(documents),
      ).toEqual([{ id: initial.value.documentId, name: "Alias", extension: "" }]);
      expect(await context.read("Alias.md")).toMatchObject({
        ok: true,
        value: { content: "Unchanged" },
      });
    });

    it("allows a Postgres rename while projection activity changes mid-flight", async () => {
      const { context, move, mutationStore } = createContextHarness();
      const initial = await context.createTrackedDocument("chapter", "Chapter");
      if (!initial.ok || !initial.value.documentId) throw new Error("initial write failed");
      let concurrentWrite: Awaited<ReturnType<ContextFS["write"]>> | null = null;
      mutationStore.setBeforeDestructiveWrite(async () => {
        mutationStore.setBeforeDestructiveWrite(null);
        concurrentWrite = await context.write("chapter", "Revised chapter");
      });

      await expect(move("chapter", "archive/chapter.txt")).resolves.toMatchObject({
        ok: true,
        value: { destinationUri: "kb://archive/chapter" },
      });

      expect(concurrentWrite).toMatchObject({
        ok: true,
        value: { documentId: initial.value.documentId },
      });
      await expect(
        db
          .select({
            id: documents.id,
            name: documents.name,
            extension: documents.extension,
            filetype: documents.fileType,
          })
          .from(documents),
      ).resolves.toEqual([
        {
          id: initial.value.documentId,
          name: "chapter",
          extension: "",
          filetype: "markdown",
        },
      ]);
      await expect(db.select().from(folders)).resolves.toHaveLength(1);
    });
  });
}
