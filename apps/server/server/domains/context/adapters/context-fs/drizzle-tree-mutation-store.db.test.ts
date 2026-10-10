/**
 * Drizzle ContextTreeMutationStore: recursive-delete ownership and rollback proofs, the move
 * barrier, and what live folder operations do to hidden nodes (contract §8: F-1…F-4, I-4, I-5).
 */
import { randomUUID } from "node:crypto";
import type { ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextAvailabilityHeads,
  contextCatalogCommits,
  contextCatalogEntries,
  contextCatalogScopeHeads,
  contextSources,
  documentMarkdownProjections,
  documentPreviousLocations,
  documents,
  documentYjsUpdates,
  draftTreeChanges,
  folders,
  projects,
  users,
} from "@meridian/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
} from "../../../../shared/drizzle-transaction.js";
import { Ok } from "../../../../shared/result.js";
import { useComposedRuntimes } from "../../../../test-support/composed-runtime.js";
import {
  type DraftTreeScenario,
  draftTreeScenario,
  type ScenarioWork,
} from "../../../../test-support/draft-tree-scenario.js";
import {
  deleteDrizzleRows,
  useRollbackTestDatabase,
} from "../../../../test-support/drizzle-reset.js";
import { interleave } from "../../../../test-support/lock-interleave.js";
import { createDrizzleCollabPersistence } from "../../../collab/adapters/drizzle-journal.js";
import { createDocumentAddressResolver } from "../../document-address.js";
import { moveNodes, type NodeMove } from "../../tree/node-moves.js";
import { createTreeReader } from "../../tree/tree-view.js";
import { createDrizzleContextCatalog } from "../context-catalog.js";
import { createDrizzleDocumentAddressStore } from "../document-address.js";
import { createDrizzleProjectContextAvailability } from "../project-context-availability.js";
import { lockContextSources } from "./document-locations.js";
import { DrizzleContextDocumentStore } from "./drizzle-store.js";
import { DrizzleContextTreeMutationStore } from "./drizzle-tree-mutation-store.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("Drizzle ContextTreeMutationStore (postgres)", () => {});
} else {
  describe("Drizzle ContextTreeMutationStore (postgres)", () => {
    const USER_ID = "00000000-0000-4000-8000-000000000701";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000702";
    const PROJECT_SCOPE_KEY = `project:${PROJECT_ID}`;
    const SOURCE_ID = "00000000-0000-4000-8000-000000000703";
    const DOC_DELETE_ID = "00000000-0000-4000-8000-000000000705";
    const DOC_AMBIENT_DELETE_ID = "00000000-0000-4000-8000-000000000710";
    const EMPTY_FOLDER_ID = "00000000-0000-4000-8000-000000000712";
    const NON_EMPTY_FOLDER_ID = "00000000-0000-4000-8000-000000000713";
    const DOC_STALE_DELETE_ID = "00000000-0000-4000-8000-000000000715";
    const DOC_ROLLBACK_DELETE_ID = "00000000-0000-4000-8000-000000000716";

    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
    });
    let db = database.current;

    beforeEach(async () => {
      db = database.current;
      await db.insert(users).values(conformanceUserValues(USER_ID, "tree-mutation"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Tree Mutation Project",
        slug: "tree-mutation-project",
      });
      await db.insert(contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        isPrimary: true,
      });
    });

    async function insertDocument(id: string, name: string) {
      await db.insert(documents).values({
        id,
        contextSourceId: SOURCE_ID,
        name,
        extension: "md",
        fileType: "markdown",
      });
      await db.insert(documentMarkdownProjections).values({ documentId: id, markdown: name });
    }

    it("keeps file and folder namespace claims exclusive in either order", async () => {
      const store = new DrizzleContextDocumentStore({ db, contextSourceId: SOURCE_ID });
      await store.createDocument({
        folderId: null,
        name: "file",
        extension: "md",
        filetype: "markdown",
        markdown: "original",
      });
      await expect(store.ensureFolderPath(["file.md"])).rejects.toThrow(
        "Context entry already exists",
      );
      await store.ensureFolderPath(["folder.md"]);
      await expect(
        store.createDocumentRecordIfAbsent({
          folderId: null,
          name: "folder",
          extension: "md",
          filetype: "markdown",
          markdown: "replacement",
        }),
      ).resolves.toBeNull();
      await expect(
        store.createDocument({
          folderId: null,
          name: "folder",
          extension: "md",
          filetype: "markdown",
          markdown: "replacement",
        }),
      ).rejects.toThrow("Context entry already exists");
    });

    it("records direct identity history and permanently consumes reused file and folder paths", async () => {
      await insertDocument(DOC_DELETE_ID, "alpha");
      const tree = new DrizzleContextTreeMutationStore(db);
      async function move(from: string, to: string) {
        const source = await tree.inspect(SOURCE_ID, from);
        if (source?.kind !== "file") throw new Error("missing source");
        expect(
          await tree.commitMove({
            source,
            destinationSourceId: SOURCE_ID,
            destinationPath: to,
            destinationFiletype: "markdown",
            graduateProvisionalName: false,
            expectedTarget: { state: "absent" },
            overwrite: false,
          }),
        ).toMatchObject({ ok: true });
      }
      await move("alpha.md", "beta.md");
      await move("beta.md", "gamma.md");
      const resolver = createDocumentAddressResolver({
        locations: createDrizzleDocumentAddressStore(db),
        availability: createDrizzleProjectContextAvailability(db),
      });
      const address = {
        projectId: PROJECT_ID,
        userId: USER_ID,
        scheme: "manuscript" as const,
        workId: null,
        path: "alpha.md",
      };
      expect(await resolver.resolve(address)).toMatchObject({
        kind: "alias",
        document: { documentId: DOC_DELETE_ID, entry: { path: ["gamma.md"] } },
      });
      expect(
        await resolver.resolve({ ...address, userId: "00000000-0000-4000-8000-000000000799" }),
      ).toEqual({ kind: "unavailable" });
      const history = () =>
        db
          .select({
            path: documentPreviousLocations.path,
            documentId: documentPreviousLocations.documentId,
          })
          .from(documentPreviousLocations)
          .orderBy(documentPreviousLocations.path);
      expect(await history()).toEqual([
        { path: "alpha.md", documentId: DOC_DELETE_ID },
        { path: "beta.md", documentId: DOC_DELETE_ID },
      ]);
      const store = new DrizzleContextDocumentStore({ db, contextSourceId: SOURCE_ID });
      const replacement = await store.createDocumentRecordIfAbsent({
        id: DOC_AMBIENT_DELETE_ID,
        folderId: null,
        name: "alpha",
        extension: "md",
        filetype: "markdown",
        markdown: "",
      });
      expect(replacement).not.toBeNull();
      await db
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, DOC_AMBIENT_DELETE_ID));
      await store.ensureFolderPath(["beta.md"]);
      expect(await history()).toEqual([]);
      expect(await resolver.resolve(address)).toEqual({ kind: "unavailable" });
      await db
        .insert(documentPreviousLocations)
        .values({ contextSourceId: SOURCE_ID, path: "beta.md", documentId: DOC_DELETE_ID });
      expect(await resolver.resolve({ ...address, path: "beta.md" })).toEqual({
        kind: "unavailable",
      });
      await db
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, DOC_DELETE_ID));
      expect(await resolver.resolve({ ...address, path: "gamma.md" })).toEqual({
        kind: "unavailable",
      });
    });

    it("records descendants of folder moves and rolls history and path claims back together", async () => {
      const store = new DrizzleContextDocumentStore({ db, contextSourceId: SOURCE_ID });
      const nestedId = await store.ensureFolderPath(["before", "nested"]);
      await store.createDocumentRecordIfAbsent({
        id: DOC_DELETE_ID,
        folderId: nestedId,
        name: "chapter",
        extension: "md",
        filetype: "markdown",
        markdown: "",
      });
      const tree = new DrizzleContextTreeMutationStore(db);
      const source = await tree.inspect(SOURCE_ID, "before");
      if (source?.kind !== "directory") throw new Error("missing folder");
      expect(
        await tree.commitMove({
          source,
          destinationSourceId: SOURCE_ID,
          destinationPath: "after",
          expectedTarget: { state: "absent" },
          overwrite: false,
        }),
      ).toMatchObject({ ok: true });
      expect(
        await db.select({ path: documentPreviousLocations.path }).from(documentPreviousLocations),
      ).toEqual([{ path: "before/nested/chapter.md" }]);
      await expect(
        runInDrizzleTransaction(db, async () => {
          const restoredNestedId = await store.ensureFolderPath(["before", "nested"]);
          await store.createDocumentRecordIfAbsent({
            id: DOC_AMBIENT_DELETE_ID,
            folderId: restoredNestedId,
            name: "chapter",
            extension: "md",
            filetype: "markdown",
            markdown: "",
          });
          expect(await db.select().from(documentPreviousLocations)).toEqual([]);
          throw new Error("rollback claim");
        }),
      ).rejects.toThrow("rollback claim");
      expect(
        await db.select({ path: documentPreviousLocations.path }).from(documentPreviousLocations),
      ).toEqual([{ path: "before/nested/chapter.md" }]);
    });

    it("preserves paths longer than a B-tree index tuple", async () => {
      let parentId: string | null = null;
      const names: string[] = [];
      const rows: Array<{
        id: string;
        parentId: string | null;
        contextSourceId: string;
        name: string;
      }> = [];
      for (let i = 0; i < 150; i++) {
        const name = randomUUID();
        const id = randomUUID();
        rows.push({ id, parentId, contextSourceId: SOURCE_ID, name });
        names.push(name);
        parentId = id;
      }
      await db.insert(folders).values(rows);
      await db.insert(documents).values({
        id: DOC_DELETE_ID,
        contextSourceId: SOURCE_ID,
        folderId: parentId,
        name: "chapter",
        extension: "md",
        fileType: "markdown",
      });
      const path = [...names, "chapter.md"].join("/");
      const tree = new DrizzleContextTreeMutationStore(db);
      const source = await tree.inspect(SOURCE_ID, path);
      if (source?.kind !== "file") throw new Error("missing document");
      expect(
        await tree.commitMove({
          source,
          destinationSourceId: SOURCE_ID,
          destinationPath: "short.md",
          destinationFiletype: "markdown",
          graduateProvisionalName: false,
          expectedTarget: { state: "absent" },
          overwrite: false,
        }),
      ).toMatchObject({ ok: true });
      expect(
        await db.select({ path: documentPreviousLocations.path }).from(documentPreviousLocations),
      ).toEqual([{ path }]);
    });

    it("deletes empty and populated folders with exact content identities", async () => {
      const nestedFolderId = "00000000-0000-4000-8000-000000000731";
      const binaryId = "00000000-0000-4000-8000-000000000732";
      const customId = "00000000-0000-4000-8000-000000000733";
      const nestedId = "00000000-0000-4000-8000-000000000734";
      await db.insert(folders).values([
        { id: EMPTY_FOLDER_ID, contextSourceId: SOURCE_ID, name: "empty" },
        { id: NON_EMPTY_FOLDER_ID, contextSourceId: SOURCE_ID, name: "occupied" },
        {
          id: nestedFolderId,
          contextSourceId: SOURCE_ID,
          parentId: NON_EMPTY_FOLDER_ID,
          name: "nested",
        },
      ]);
      await db.insert(documents).values([
        {
          id: DOC_DELETE_ID,
          contextSourceId: SOURCE_ID,
          folderId: NON_EMPTY_FOLDER_ID,
          name: "tracked",
          extension: "md",
          fileType: "markdown",
        },
        {
          id: binaryId,
          contextSourceId: SOURCE_ID,
          folderId: NON_EMPTY_FOLDER_ID,
          name: "binary",
          extension: "pdf",
          fileType: "pdf",
          storageUrl: "s3://binary",
        },
        {
          id: customId,
          contextSourceId: SOURCE_ID,
          folderId: NON_EMPTY_FOLDER_ID,
          name: "custom",
          extension: "svg",
          fileType: "svg",
        },
        {
          id: nestedId,
          contextSourceId: SOURCE_ID,
          folderId: nestedFolderId,
          name: "nested",
          extension: "md",
          fileType: "markdown",
        },
      ]);
      const availability = createDrizzleProjectContextAvailability(db);
      const catalog = createDrizzleContextCatalog(db, undefined, {
        availabilityMutations: availability,
      });
      await catalog.refreshSources([SOURCE_ID]);
      const tree = new DrizzleContextTreeMutationStore(db, catalog);
      const empty = await tree.inspect(SOURCE_ID, "empty");
      const occupied = await tree.inspect(SOURCE_ID, "occupied");
      if (!empty || !occupied) throw new Error("expected folder tokens");

      const emptyResult = await tree.commitRecursiveDelete({ root: empty, mode: "recursive" });
      expect(emptyResult).toMatchObject({ ok: true, value: { deletedDocumentIds: [] } });
      const scope = { kind: "project", projectId: PROJECT_ID } as const;
      const beforePopulated = await catalog.snapshot(scope);
      const populatedResult = await tree.commitRecursiveDelete({
        root: occupied,
        mode: "recursive",
      });
      expect(populatedResult).toMatchObject({
        ok: true,
        value: { deletedDocumentIds: [DOC_DELETE_ID, binaryId, customId, nestedId].sort() },
      });
      if (!emptyResult.ok || !populatedResult.ok) throw new Error("expected recursive receipts");
      expect(BigInt(populatedResult.value.availabilityGeneration)).toBeGreaterThan(
        BigInt(emptyResult.value.availabilityGeneration),
      );
      await expect(catalog.changes(scope, beforePopulated.cursor)).resolves.toMatchObject({
        kind: "delta",
        commits: [expect.objectContaining({ changes: expect.any(Array) })],
      });
      await expect(tree.inspect(SOURCE_ID, "occupied")).resolves.toBeNull();
      const tombstones = await db
        .select({ deletedAt: documents.deletedAt })
        .from(documents)
        .where(eq(documents.contextSourceId, SOURCE_ID));
      expect(tombstones).toHaveLength(4);
      expect(new Set(tombstones.map((row) => row.deletedAt?.toISOString()))).toHaveLength(1);
    });

    it("returns no receipt when delete CAS becomes stale or the transaction rolls back", async () => {
      await insertDocument(DOC_STALE_DELETE_ID, "stale-delete");
      await insertDocument(DOC_ROLLBACK_DELETE_ID, "rollback-delete");
      const tree = new DrizzleContextTreeMutationStore(db, createDrizzleContextCatalog(db));
      const stale = await tree.inspect(SOURCE_ID, "stale-delete.md");
      const rollbackToken = await tree.inspect(SOURCE_ID, "rollback-delete.md");
      if (!stale || !rollbackToken) throw new Error("expected file tokens");

      await db
        .update(documents)
        .set({ name: "moved-before-delete" })
        .where(eq(documents.id, DOC_STALE_DELETE_ID));
      await expect(tree.commitRecursiveDelete({ root: stale, mode: "recursive" })).resolves.toEqual(
        {
          ok: false,
          error: { code: "stale_source" },
        },
      );

      const rollbackFailure = new Error("abort destructive write");
      tree.setBeforeDestructiveWrite(() => {
        throw rollbackFailure;
      });
      await expect(
        tree.commitRecursiveDelete({ root: rollbackToken, mode: "recursive" }),
      ).rejects.toBe(rollbackFailure);
      const [rolledBack] = await db
        .select({ deletedAt: documents.deletedAt })
        .from(documents)
        .where(eq(documents.id, DOC_ROLLBACK_DELETE_ID));
      expect(rolledBack?.deletedAt).toBeNull();
    });

    it.each([
      "after-catalog-refresh",
    ] as const)("rolls back every recursive-delete effect when failure is injected %s", async (failurePoint) => {
      const folderId = "00000000-0000-4000-8000-000000000741";
      const documentId = "00000000-0000-4000-8000-000000000743";
      await db.insert(folders).values({ id: folderId, contextSourceId: SOURCE_ID, name: folderId });
      await db.insert(documents).values({
        id: documentId,
        contextSourceId: SOURCE_ID,
        folderId,
        name: documentId,
      });
      const publish = vi.fn();
      const catalog = createDrizzleContextCatalog(db, { publish });
      const failure = new Error(failurePoint);
      const failingCatalog = {
        refreshProject: (projectId: string) => catalog.refreshProject(projectId),
        async refreshSources(sourceIds: readonly string[], invalidatedRootIds?: readonly string[]) {
          await catalog.refreshSources(sourceIds, invalidatedRootIds);
          throw failure;
        },
      };
      const tree = new DrizzleContextTreeMutationStore(db, failingCatalog);
      const token = await tree.inspect(SOURCE_ID, folderId);
      if (!token) throw new Error("expected folder token");

      await expect(tree.commitRecursiveDelete({ root: token, mode: "recursive" })).rejects.toBe(
        failure,
      );

      const [document] = await db
        .select({ deletedAt: documents.deletedAt })
        .from(documents)
        .where(eq(documents.id, documentId));
      const [folder] = await db
        .select({ deletedAt: folders.deletedAt })
        .from(folders)
        .where(eq(folders.id, folderId));
      expect(document?.deletedAt).toBeNull();
      expect(folder?.deletedAt).toBeNull();
      expect(
        await db
          .select()
          .from(contextCatalogScopeHeads)
          .where(eq(contextCatalogScopeHeads.scopeKey, PROJECT_SCOPE_KEY)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(contextCatalogEntries)
          .where(eq(contextCatalogEntries.scopeKey, PROJECT_SCOPE_KEY)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(contextCatalogCommits)
          .where(eq(contextCatalogCommits.scopeKey, PROJECT_SCOPE_KEY)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(contextAvailabilityHeads)
          .where(eq(contextAvailabilityHeads.authorityKey, PROJECT_SCOPE_KEY)),
      ).toEqual([]);
      expect(publish).not.toHaveBeenCalled();

      // Committed setup lets this arm detect a delete escaping the outer command transaction.
      const committed = createDb(DATABASE_URL, { max: 2 });
      const userId = randomUUID();
      const projectId = randomUUID();
      const sourceId = randomUUID();
      const parentId = randomUUID();
      const childId = randomUUID();
      const scopeKey = `project:${projectId}`;
      const outerPublish = vi.fn();
      const availability = createDrizzleProjectContextAvailability(committed);
      const outerCatalog = createDrizzleContextCatalog(
        committed,
        { publish: outerPublish },
        {
          availabilityMutations: availability,
        },
      );
      try {
        await committed.insert(users).values(conformanceUserValues(userId, "delete-outer-abort"));
        await committed
          .insert(projects)
          .values({ id: projectId, userId, name: "Rollback", slug: "rollback" });
        await committed.insert(contextSources).values({
          id: sourceId,
          projectId,
          name: "Manuscript",
          slug: "manuscript",
          scope: "project",
          isPrimary: true,
        });
        await committed
          .insert(folders)
          .values({ id: parentId, contextSourceId: sourceId, name: "parent" });
        await committed.insert(documents).values({
          id: childId,
          contextSourceId: sourceId,
          folderId: parentId,
          name: "child",
          extension: "md",
        });
        await outerCatalog.refreshSources([sourceId]);
        const committedPublications = () =>
          Promise.all([
            committed
              .select()
              .from(contextCatalogScopeHeads)
              .where(eq(contextCatalogScopeHeads.scopeKey, scopeKey)),
            committed
              .select()
              .from(contextCatalogEntries)
              .where(eq(contextCatalogEntries.scopeKey, scopeKey))
              .orderBy(contextCatalogEntries.entryId),
            committed
              .select()
              .from(contextCatalogCommits)
              .where(eq(contextCatalogCommits.scopeKey, scopeKey))
              .orderBy(contextCatalogCommits.eventId),
            committed
              .select()
              .from(contextAvailabilityHeads)
              .where(eq(contextAvailabilityHeads.authorityKey, scopeKey)),
          ]);
        const before = await committedPublications();
        outerPublish.mockClear();
        const outerTree = new DrizzleContextTreeMutationStore(committed, outerCatalog);
        const parent = await outerTree.inspect(sourceId, "parent");
        if (!parent) throw new Error("expected committed folder token");
        const outerFailure = new Error("abort after successful delete");
        await expect(
          runInDrizzleTransaction(committed, async () => {
            const deleted = await outerTree.commitRecursiveDelete({
              root: parent,
              mode: "recursive",
            });
            expect(deleted).toMatchObject({ ok: true, value: { deletedDocumentIds: [childId] } });
            await expect(outerTree.inspect(sourceId, "parent/child.md")).resolves.toBeNull();
            throw outerFailure;
          }),
        ).rejects.toBe(outerFailure);
        await expect(outerTree.inspect(sourceId, "parent")).resolves.toMatchObject({
          nodeId: parentId,
        });
        await expect(outerTree.inspect(sourceId, "parent/child.md")).resolves.toMatchObject({
          nodeId: childId,
        });
        const [document] = await committed
          .select({ deletedAt: documents.deletedAt })
          .from(documents)
          .where(eq(documents.id, childId));
        const [folder] = await committed
          .select({ deletedAt: folders.deletedAt })
          .from(folders)
          .where(eq(folders.id, parentId));
        expect(document?.deletedAt).toBeNull();
        expect(folder?.deletedAt).toBeNull();
        expect(await committedPublications()).toEqual(before);
        expect(outerPublish).not.toHaveBeenCalled();
      } finally {
        await committed
          .delete(contextCatalogScopeHeads)
          .where(eq(contextCatalogScopeHeads.scopeKey, scopeKey));
        await committed
          .delete(contextAvailabilityHeads)
          .where(eq(contextAvailabilityHeads.authorityKey, scopeKey));
        await committed.delete(users).where(eq(users.id, userId));
        await committed.close();
      }
    });
  });

  // Committed rows and two connections: the barrier is only visible across sessions.
  describe("Drizzle ContextTreeMutationStore move barrier (postgres)", () => {
    const committed = createDb(DATABASE_URL, { max: 4 });
    const probe = createDb(DATABASE_URL, { max: 2 });
    const userId = randomUUID();
    const projectId = randomUUID();
    const sourceId = randomUUID();
    beforeEach(async () => {
      await deleteDrizzleRows(committed, [users]);
      await committed.insert(users).values(conformanceUserValues(userId, "move-barrier"));
      await committed
        .insert(projects)
        .values({ id: projectId, userId, name: "Barrier", slug: "barrier" });
      await committed.insert(contextSources).values({
        id: sourceId,
        projectId,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        isPrimary: true,
      });
    });
    afterAll(async () => {
      await deleteDrizzleRows(committed, [users]);
      await Promise.all([committed.close(), probe.close()]);
    });

    it("a same-source move row-locks its document, and a journal FK insert still completes under it", async () => {
      const holder = randomUUID();
      await committed
        .insert(documents)
        .values({ id: holder, contextSourceId: sourceId, name: "holder", extension: "md" });
      const persistence = createDrizzleCollabPersistence(committed);
      await persistence.lifecycle.ensureDocument(holder as never);
      const tree = new DrizzleContextTreeMutationStore(committed);
      const source = await tree.inspect(sourceId, "holder.md");
      if (source?.kind !== "file") throw new Error("Missing holder");
      let paused!: () => void;
      const atDestructiveWrite = new Promise<void>((resolve) => {
        paused = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      tree.setBeforeDestructiveWrite(async () => {
        paused();
        await gate;
      });
      const moving = tree.commitMove({
        source,
        destinationSourceId: sourceId,
        destinationPath: "moved-holder.md",
        expectedTarget: { state: "absent" },
        overwrite: false,
        destinationFiletype: "markdown",
        graduateProvisionalName: false,
      });
      const doc = new Y.Doc();
      try {
        await atDestructiveWrite;
        // Before any DML the move already holds the row: derive's NO KEY UPDATE queues on it.
        const rowLock = await probe
          .transaction((tx) =>
            tx.execute(sql`SELECT id FROM documents WHERE id = ${holder} FOR NO KEY UPDATE NOWAIT`),
          )
          .then(
            () => "free",
            () => "locked",
          );
        expect(rowLock).toBe("locked");
        // The journal FK takes KEY SHARE on the holder: compatible, so it never waits on a move.
        await runInDrizzleTransaction(probe, async () => {
          await currentDrizzleDb(probe).execute(sql`SET LOCAL lock_timeout = '2s'`);
          await createDrizzleCollabPersistence(probe).journal.append(
            holder as never,
            Y.encodeStateAsUpdate(doc),
            { origin: `human:${userId}`, seq: 0 },
          );
        });
      } finally {
        release();
        await Promise.allSettled([moving]);
        doc.destroy();
      }
      expect(await moving).toMatchObject({ ok: true });
      expect(
        await committed
          .select()
          .from(documentYjsUpdates)
          .where(eq(documentYjsUpdates.documentId, holder)),
      ).toHaveLength(1);
    });
  });

  // Contract §8 through the real commands: what live folder operations do to hidden nodes.
  describe("live folder operations keep hidden nodes where their drafts expect them (postgres)", () => {
    // Commands publish catalog work after commit, so this suite commits for real.
    const committed = createDb(DATABASE_URL, { max: 12 });
    afterAll(() => committed.close());
    const runtimes = useComposedRuntimes(() => committed);
    beforeEach(async () => {
      await deleteDrizzleRows(committed, [users]);
    });

    async function start() {
      const runtime = await runtimes.compose();
      return draftTreeScenario(committed, { runtime, runtimes });
    }

    async function document(id: string) {
      const [row] = await committed
        .select({
          hidden: documents.hidden,
          deleted: sql<boolean>`${documents.deletedAt} IS NOT NULL`,
          contextSourceId: documents.contextSourceId,
          folderId: documents.folderId,
          locationVersion: documents.locationVersion,
        })
        .from(documents)
        .where(eq(documents.id, id));
      if (!row) throw new Error(`no document ${id}`);
      return row;
    }

    async function folder(id: string | null) {
      const [row] = await committed
        .select({
          name: folders.name,
          hidden: folders.hidden,
          deleted: sql<boolean>`${folders.deletedAt} IS NOT NULL`,
          contextSourceId: folders.contextSourceId,
          parentId: folders.parentId,
          locationVersion: folders.locationVersion,
        })
        .from(folders)
        .where(eq(folders.id, id ?? randomUUID()));
      if (!row) throw new Error(`no folder ${id}`);
      return row;
    }

    async function changeRow(draftId: string, documentId: string) {
      const [row] = await committed
        .select({
          contextSourceId: draftTreeChanges.contextSourceId,
          parentFolderId: draftTreeChanges.parentFolderId,
        })
        .from(draftTreeChanges)
        .where(and(eq(draftTreeChanges.draftId, draftId), eq(draftTreeChanges.nodeId, documentId)));
      return row ?? null;
    }

    async function idAt(
      scenario: DraftTreeScenario,
      of: ScenarioWork | "live",
      path: string,
    ): Promise<string | null> {
      const stat = await scenario.view(of).stat(path);
      return stat.ok ? (stat.value.documentId ?? null) : null;
    }

    /** Apply's relocation shape: several nodes through the batch primitive, rolled back on refusal. */
    async function batchMove(
      sourceIds: readonly string[],
      moves: readonly NodeMove[],
    ): Promise<{ ok: true } | { ok: false; code: string }> {
      class Refused extends Error {
        constructor(readonly code: string) {
          super(code);
        }
      }
      try {
        await runInDrizzleTransaction(committed, async () => {
          await lockContextSources(committed, sourceIds);
          const moved = await moveNodes(committed, { moves, filetypeFor: () => Ok(null) });
          if (!moved.ok) throw new Refused(moved.error.code);
        });
        return { ok: true };
      } catch (error) {
        if (error instanceof Refused) return { ok: false, code: error.code };
        const cause = (error as { cause?: { code?: string } }).cause;
        return { ok: false, code: cause?.code ?? String(error) };
      }
    }

    const toFolder = (
      id: string,
      sourceId: string,
      name: string,
      dir: string[] = [],
    ): NodeMove => ({
      node: { kind: "folder", id: id as FolderId },
      to: { contextSourceId: sourceId as ContextSourceId, dir, name },
    });
    const toDocument = (
      id: string,
      sourceId: string,
      name: string,
      dir: string[] = [],
    ): NodeMove => ({
      node: { kind: "document", id: id as DocumentId },
      to: { contextSourceId: sourceId as ContextSourceId, dir, name, extension: "md" },
    });

    /** No temporary vacate name survives anywhere in these sources. */
    async function parkedNames(sourceIds: readonly string[]) {
      return committed
        .select({ name: folders.name })
        .from(folders)
        .where(
          and(
            inArray(folders.contextSourceId, sourceIds as ContextSourceId[]),
            sql`position(chr(1) in ${folders.name}) > 0`,
          ),
        );
    }

    it("splits a nested hidden document off a deleted folder into twins at its path (F-1)", async () => {
      const scenario = await start();
      const ascension = await scenario.work("Ascension", "draft");
      const kept = await scenario.seedLive("world/places/kept.md");
      const world = await scenario.seedLiveFolder("world");
      const places = await scenario.seedLiveFolder("world/places");
      const harbor = await scenario.model(ascension).create("world/places/harbor.md", "Harbor.");
      const draft = await scenario.draftOf(ascension);
      const before = await document(harbor);

      const deleted = await scenario.writer.delete("world");
      expect.soft(deleted, "the live delete").toMatchObject({ ok: true });
      if (deleted.ok) {
        expect
          .soft(deleted.value.deletedDocumentIds, "receipt names live rows only")
          .toEqual([kept]);
      }

      const now = await document(harbor);
      expect.soft(now, "harbor stays hidden and live").toMatchObject({
        hidden: true,
        deleted: false,
        contextSourceId: scenario.project.sources.manuscript,
        locationVersion: before.locationVersion,
      });
      const placesTwin = await folder(now.folderId);
      const worldTwin = await folder(placesTwin.parentId);
      expect.soft(now.folderId, "under a new folder").not.toBe(places);
      expect.soft(placesTwin, "places' twin").toMatchObject({
        name: "places",
        hidden: true,
        deleted: false,
        locationVersion: 0n,
      });
      expect.soft(placesTwin.parentId, "under world's twin").not.toBe(world);
      expect.soft(worldTwin, "world's twin, with no hidden child of its own").toMatchObject({
        name: "world",
        hidden: true,
        deleted: false,
        parentId: null,
        locationVersion: 0n,
      });
      expect.soft(await changeRow(draft.id, harbor), "change row repointed").toEqual({
        contextSourceId: scenario.project.sources.manuscript,
        parentFolderId: now.folderId,
      });
      expect
        .soft(
          [await folder(world), await folder(places), await document(kept)],
          "deleted rows each take a version",
        )
        .toEqual([
          expect.objectContaining({ deleted: true, locationVersion: 1n }),
          expect.objectContaining({ deleted: true, locationVersion: 1n }),
          expect.objectContaining({ deleted: true, locationVersion: 1n }),
        ]);
      expect
        .soft(await idAt(scenario, ascension, "world/places/harbor.md"), "the draft still sees it")
        .toBe(harbor);
      expect
        .soft(await idAt(scenario, "live", "world/places/harbor.md"), "live does not")
        .toBeNull();
    });

    it("moves hidden contents with a folder between project sources and repoints their source (F-2)", async () => {
      const scenario = await start();
      const ascension = await scenario.work("Ascension", "draft");
      const rival = await scenario.work("Rival", "draft");
      const outline = await scenario.seedLive("notes/outline.md");
      const notes = await scenario.seedLiveFolder("notes");
      const idea = await scenario.model(ascension).create("notes/idea.md", "Idea.");
      const plan = await scenario.model(rival).create("notes/deep/plan.md", "Plan.");
      const [ideaBefore, planBefore] = [await document(idea), await document(plan)];

      expect
        .soft(await scenario.writer.move("notes", "kb://notes"), "the live move")
        .toMatchObject({ ok: true });

      const kb = scenario.project.sources.kb;
      for (const [work, id, path, before] of [
        [ascension, idea, "notes/idea.md", ideaBefore],
        [rival, plan, "notes/deep/plan.md", planBefore],
      ] as const) {
        const draft = await scenario.draftOf(work);
        expect.soft(await document(id), `${path}: moved along, hidden`).toMatchObject({
          hidden: true,
          deleted: false,
          contextSourceId: kb,
          locationVersion: before.locationVersion + 1n,
        });
        expect
          .soft((await changeRow(draft.id, id))?.contextSourceId, `${path}: row takes the source`)
          .toBe(kb);
        expect.soft(await idAt(scenario, work, `kb://${path}`), `${path}: in its draft`).toBe(id);
        expect.soft(await idAt(scenario, work, path), `${path}: not left behind`).toBeNull();
        expect.soft(await idAt(scenario, "live", `kb://${path}`), `${path}: not live`).toBeNull();
      }
      expect.soft(await idAt(scenario, "live", "kb://notes/outline.md")).toBe(outline);
      expect.soft((await folder(notes)).locationVersion, "the moved folder's version").toBe(1n);

      // The batch primitive's final namespace includes what moving folders carry (F-R1).
      const m = scenario.project.sources.manuscript;
      const a = await scenario.seedLiveFolder("a");
      await scenario.seedLive("a/x.md");
      const c = await scenario.seedLive("c.md");
      expect
        .soft(await batchMove([m], [toFolder(a, m, "b"), toDocument(c, m, "x", ["b"])]))
        .toEqual({ ok: false, code: "conflict" });
      const e = await scenario.seedLiveFolder("e");
      await scenario.seedLiveFolder("e/x.md");
      const f = await scenario.seedLive("f.md");
      expect
        .soft(await batchMove([m], [toFolder(e, m, "g"), toDocument(f, m, "x", ["g"])]))
        .toEqual({ ok: false, code: "conflict" });
      expect.soft(await idAt(scenario, "live", "f.md"), "a refused batch moves nothing").toBe(f);
      // A selected child vacating the slot its folder carries frees it.
      const h = await scenario.seedLiveFolder("h");
      const hx = await scenario.seedLive("h/x.md");
      const k = await scenario.seedLive("k.md");
      expect
        .soft(
          await batchMove(
            [m],
            [toFolder(h, m, "i"), toDocument(hx, m, "z"), toDocument(k, m, "x", ["i"])],
          ),
        )
        .toEqual({ ok: true });
      expect.soft(await idAt(scenario, "live", "i/x.md"), "freed slot").toBe(k);
      expect.soft(await idAt(scenario, "live", "z.md"), "selected child").toBe(hx);
      // A swap leaves no alias at a path the final tree occupies (F-R3).
      const sDoc = await scenario.seedLive("s.md");
      const tDoc = await scenario.seedLive("t.md");
      expect
        .soft(await batchMove([m], [toDocument(sDoc, m, "t"), toDocument(tDoc, m, "s")]))
        .toEqual({ ok: true });
      expect
        .soft(
          await committed
            .select({ path: documentPreviousLocations.path })
            .from(documentPreviousLocations)
            .where(
              and(
                eq(documentPreviousLocations.contextSourceId, m),
                inArray(documentPreviousLocations.path, ["s.md", "t.md"]),
              ),
            ),
          "swap history",
        )
        .toEqual([]);
      expect
        .soft([(await document(sDoc)).locationVersion, (await document(tDoc)).locationVersion])
        .toEqual([1n, 1n]);
    });

    it("splits a nested hidden document off a folder moved out of the project or into a Work's Scratch (F-3)", async () => {
      // Personal ↔ project (§8.3), and a Work's Scratch, which no draft ever holds.
      for (const into of ["user", "scratch"] as const) {
        const scenario = await start();
        const ascension = await scenario.work(`Ascension ${into}`, "draft");
        const destination =
          into === "user"
            ? "user://world"
            : `scratch://@${(await scenario.work("Notes", "direct")).slug}/world`;
        const map = await scenario.seedLive("world/places/map.md");
        const places = await scenario.seedLiveFolder("world/places");
        const harbor = await scenario.model(ascension).create("world/places/harbor.md", "Harbor.");
        const draft = await scenario.draftOf(ascension);

        expect
          .soft(await scenario.writer.move("world", destination), `${destination}: the live move`)
          .toMatchObject({ ok: true });

        const now = await document(harbor);
        expect.soft(now, `${destination}: harbor stays in Manuscript, hidden`).toMatchObject({
          hidden: true,
          deleted: false,
          contextSourceId: scenario.project.sources.manuscript,
        });
        expect.soft(now.folderId, `${destination}: under a twin`).not.toBe(places);
        const twin = await folder(now.folderId);
        expect.soft(twin, `${destination}: places' twin`).toMatchObject({
          name: "places",
          hidden: true,
          contextSourceId: scenario.project.sources.manuscript,
        });
        expect.soft(await folder(twin.parentId), `${destination}: world's twin`).toMatchObject({
          name: "world",
          hidden: true,
          parentId: null,
        });
        expect
          .soft((await folder(places)).contextSourceId, `${destination}: the live folder left`)
          .not.toBe(scenario.project.sources.manuscript);
        expect.soft(await changeRow(draft.id, harbor), `${destination}: row repointed`).toEqual({
          contextSourceId: scenario.project.sources.manuscript,
          parentFolderId: now.folderId,
        });
        expect
          .soft(
            await idAt(scenario, ascension, "world/places/harbor.md"),
            `${destination}: the draft still sees it`,
          )
          .toBe(harbor);
        expect
          .soft(await idAt(scenario, "live", `${destination}/places/map.md`), destination)
          .toBe(map);
      }

      // Overlapping selected folders in one batch (F-R2): a selected child owns its subtree,
      // and a split twins at original coordinates even when an ancestor moves too.
      const scenario = await start();
      const elsewhere = (await start()).project.sources.manuscript;
      const { manuscript: m, kb } = scenario.project.sources;
      const sources = [m, kb, elsewhere];
      const ascension = await scenario.work("Ascension overlap", "draft");
      const draft = await scenario.draftOf(ascension);
      // The parent leaves the project; the child stays in it, so its hidden contents follow it.
      await scenario.seedLive("p/r/visible.md");
      const [p, r] = [await scenario.seedLiveFolder("p"), await scenario.seedLiveFolder("p/r")];
      const followed = await scenario.model(ascension).create("p/r/hidden.md", "Hidden.");
      const followedBefore = await document(followed);
      expect
        .soft(await batchMove(sources, [toFolder(p, elsewhere, "p"), toFolder(r, kb, "r")]))
        .toEqual({ ok: true });
      expect.soft(await document(followed), "moved with its own folder").toMatchObject({
        hidden: true,
        contextSourceId: kb,
        folderId: r,
        locationVersion: followedBefore.locationVersion + 1n,
      });
      expect.soft(await changeRow(draft.id, followed), "its row follows").toEqual({
        contextSourceId: kb,
        parentFolderId: r,
      });
      expect.soft(await idAt(scenario, ascension, "kb://r/hidden.md")).toBe(followed);
      // The parent stays in the project; the child leaves, so its hidden contents split off
      // under twins at the original path, the moved parent included.
      await scenario.seedLive("q/t/visible.md");
      const [q, t] = [await scenario.seedLiveFolder("q"), await scenario.seedLiveFolder("q/t")];
      const stayed = await scenario.model(ascension).create("q/t/hidden.md", "Hidden.");
      const stayedBefore = await document(stayed);
      expect
        .soft(await batchMove(sources, [toFolder(q, kb, "q"), toFolder(t, elsewhere, "t")]))
        .toEqual({ ok: true });
      const kept = await document(stayed);
      expect.soft(kept, "split off, unchanged").toMatchObject({
        hidden: true,
        contextSourceId: m,
        locationVersion: stayedBefore.locationVersion,
      });
      const tTwin = await folder(kept.folderId);
      expect.soft(kept.folderId, "under a twin").not.toBe(t);
      expect.soft(tTwin, "t's twin").toMatchObject({ name: "t", hidden: true, contextSourceId: m });
      expect.soft(await folder(tTwin.parentId), "q's twin, at q's old path").toMatchObject({
        name: "q",
        hidden: true,
        contextSourceId: m,
        parentId: null,
      });
      expect.soft(tTwin.parentId, "not the moved q").not.toBe(q);
      expect.soft((await changeRow(draft.id, stayed))?.parentFolderId).toBe(kept.folderId);
      expect.soft(await idAt(scenario, ascension, "q/t/hidden.md")).toBe(stayed);
      expect.soft(await parkedNames(sources), "no parked name persists").toEqual([]);
    });

    it("absorbs a hidden folder beside a same-named visible document: a draft clash, never a live refusal (F-4)", async () => {
      const scenario = await start();
      const ascension = await scenario.work("Ascension", "draft");
      const kaelFile = await scenario.seedLive("drafts/kael");
      const drafts = await scenario.seedLiveFolder("drafts");
      const notes = await scenario.model(ascension).create("ideas/kael/notes.md", "Notes.");
      const draft = await scenario.draftOf(ascension);
      const hiddenKael = (await document(notes)).folderId;
      const hiddenIdeas = (await folder(hiddenKael)).parentId;

      expect
        .soft(await scenario.writer.move("drafts", "ideas"), "no live refusal")
        .toMatchObject({ ok: true });

      expect.soft(await folder(hiddenIdeas), "the hidden folder tombstoned").toMatchObject({
        deleted: true,
        locationVersion: 1n,
      });
      expect.soft(await folder(hiddenKael), "its child folded in").toMatchObject({
        hidden: true,
        deleted: false,
        parentId: drafts,
        locationVersion: 0n,
      });
      expect.soft(await idAt(scenario, "live", "ideas/kael"), "the live file").toBe(kaelFile);
      const resolved = await createTreeReader(committed).resolvePath(
        { kind: "draft", draftId: draft.id },
        { contextSourceId: scenario.project.sources.manuscript, path: "ideas/kael" },
      );
      expect.soft(resolved.kind, "two nodes at one path in the draft").toBe("ambiguous");
      const [item] = await createTreeReader(committed).treeState(draft.id);
      expect.soft(item?.conflict, "a clash in the draft's view").toEqual({
        kind: "clash",
        withNode: { kind: "document", id: kaelFile },
        at: "ideas/kael",
      });
      await expect(scenario.apply(ascension, [notes]), "held at Apply").rejects.toThrow(
        "Another file holds ideas/kael",
      );
      expect.soft((await document(notes)).hidden, "still hidden after Apply").toBe(true);
    });

    it("never leaves a draft's create under an absorbed folder (I-4)", async () => {
      for (const order of ["absorb first", "create first"] as const) {
        const scenario = await start();
        const ascension = await scenario.work(`Ascension ${order}`, "draft");
        const notes = await scenario.seedLiveFolder("notes");
        const first = await scenario.model(ascension).create("ideas/first.md", "First.");
        const hiddenIdeas = (await document(first)).folderId;
        const rename = () => scenario.writer.move("notes", "ideas");
        const create = () => scenario.model(ascension).create("ideas/second.md", "Second.");
        const settled =
          order === "absorb first"
            ? await interleave(committed, rename, "absorb.beforeRepoint", create)
            : await interleave(committed, create, "createInDraft.afterCandidateLock", rename);
        expect.soft(settled.bWaited, `${order}: the second waits`).toBe(true);
        expect.soft(settled.a.ok && settled.b.ok, `${order}: both settle`).toBe(true);
        const [renamed, created] =
          order === "absorb first" ? [settled.a, settled.b] : [settled.b, settled.a];
        expect.soft(renamed.ok && renamed.value, `${order}: renamed`).toMatchObject({ ok: true });
        const second = created.ok ? (created.value as string) : "";
        const draft = await scenario.draftOf(ascension);
        expect.soft((await folder(hiddenIdeas)).deleted, `${order}: absorbed`).toBe(true);
        for (const id of [first, second]) {
          expect.soft(await document(id), `${order}: under the live folder`).toMatchObject({
            hidden: true,
            deleted: false,
            folderId: notes,
          });
          expect
            .soft((await changeRow(draft.id, id))?.parentFolderId, `${order}: its row too`)
            .toBe(notes);
        }
        expect.soft(await idAt(scenario, ascension, "ideas/second.md")).toBe(second);
      }
    });

    it("never leaves a draft's create in a split folder (I-5)", async () => {
      for (const order of ["split first", "create first"] as const) {
        const scenario = await start();
        const ascension = await scenario.work(`Ascension ${order}`, "draft");
        await scenario.seedLive("world/places/kept.md");
        const places = await scenario.seedLiveFolder("world/places");
        const first = await scenario.model(ascension).create("world/places/first.md", "First.");
        const remove = () => scenario.writer.delete("world");
        const create = () => scenario.model(ascension).create("world/places/second.md", "Second.");
        const settled =
          order === "split first"
            ? await interleave(committed, remove, "split.beforeRepoint", create)
            : await interleave(committed, create, "createInDraft.afterCandidateLock", remove);
        expect.soft(settled.bWaited, `${order}: the second waits`).toBe(true);
        expect.soft(settled.a.ok && settled.b.ok, `${order}: both settle`).toBe(true);
        const created = order === "split first" ? settled.b : settled.a;
        const second = created.ok ? (created.value as string) : "";
        const draft = await scenario.draftOf(ascension);
        const twin = (await document(first)).folderId;
        expect.soft(twin, `${order}: split off`).not.toBe(places);
        for (const id of [first, second]) {
          expect.soft(await document(id), `${order}: hidden in the twin`).toMatchObject({
            hidden: true,
            deleted: false,
            folderId: twin,
          });
          expect
            .soft((await changeRow(draft.id, id))?.parentFolderId, `${order}: its row too`)
            .toBe(twin);
        }
        expect.soft(await idAt(scenario, ascension, "world/places/second.md")).toBe(second);
      }
    });
  });
}
