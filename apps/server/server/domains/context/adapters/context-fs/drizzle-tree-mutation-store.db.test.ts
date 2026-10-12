/**
 * Drizzle ContextTreeMutationStore: recursive-delete ownership and rollback proofs, and the
 * move barrier. What live folder operations do to hidden nodes is
 * `tree/folder-normalization.db.test.ts`.
 */
import { randomUUID } from "node:crypto";
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
  folders,
  projects,
  users,
} from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
} from "../../../../shared/drizzle-transaction.js";
import {
  deleteDrizzleRows,
  useRollbackTestDatabase,
} from "../../../../test-support/drizzle-reset.js";
import { createDrizzleCollabPersistence } from "../../../collab/adapters/drizzle-journal.js";
import { createDocumentAddressResolver } from "../../document-address.js";
import { LIVE_TREE } from "../../tree/tree-view.js";
import { createDrizzleContextCatalog } from "../context-catalog.js";
import { createDrizzleDocumentAddressStore } from "../document-address.js";
import { createDrizzleProjectContextAvailability } from "../project-context-availability.js";
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
        extension: "",
        fileType: "markdown",
      });
      await db.insert(documentMarkdownProjections).values({ documentId: id, markdown: name });
    }

    it("keeps file and folder namespace claims exclusive in either order", async () => {
      const store = new DrizzleContextDocumentStore({ db, contextSourceId: SOURCE_ID });
      await store.createDocument({
        folderId: null,
        name: "file",
        extension: "",
        filetype: "markdown",
        markdown: "original",
      });
      await expect(store.ensureFolderPath(["file"])).rejects.toMatchObject({
        name: "ContextEntryConflictError",
        occupantKind: "file",
      });
      await store.ensureFolderPath(["folder"]);
      await expect(
        store.createDocumentRecordIfAbsent({
          folderId: null,
          name: "folder",
          extension: "",
          filetype: "markdown",
          markdown: "replacement",
        }),
      ).rejects.toMatchObject({ name: "ContextEntryConflictError", occupantKind: "folder" });
      await expect(
        store.createDocument({
          folderId: null,
          name: "folder",
          extension: "",
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
      await move("alpha", "beta");
      await move("beta", "gamma");
      const resolver = createDocumentAddressResolver({
        locations: createDrizzleDocumentAddressStore(db),
        availability: createDrizzleProjectContextAvailability(db),
      });
      const address = {
        projectId: PROJECT_ID,
        userId: USER_ID,
        scheme: "manuscript" as const,
        workId: null,
        path: "alpha",
      };
      expect(await resolver.resolve(address)).toMatchObject({
        kind: "alias",
        document: { documentId: DOC_DELETE_ID, entry: { path: ["gamma"] } },
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
        { path: "alpha", documentId: DOC_DELETE_ID },
        { path: "beta", documentId: DOC_DELETE_ID },
      ]);
      const store = new DrizzleContextDocumentStore({ db, contextSourceId: SOURCE_ID });
      const replacement = await store.createDocumentRecordIfAbsent({
        id: DOC_AMBIENT_DELETE_ID,
        folderId: null,
        name: "alpha",
        extension: "",
        filetype: "markdown",
        markdown: "",
      });
      expect(replacement).not.toBeNull();
      await db
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, DOC_AMBIENT_DELETE_ID));
      await store.ensureFolderPath(["beta"]);
      expect(await history()).toEqual([]);
      expect(await resolver.resolve(address)).toEqual({ kind: "unavailable" });
      await db
        .insert(documentPreviousLocations)
        .values({ contextSourceId: SOURCE_ID, path: "beta", documentId: DOC_DELETE_ID });
      expect(await resolver.resolve({ ...address, path: "beta" })).toEqual({
        kind: "unavailable",
      });
      await db
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, DOC_DELETE_ID));
      expect(await resolver.resolve({ ...address, path: "gamma" })).toEqual({
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
        extension: "",
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
      ).toEqual([{ path: "before/nested/chapter" }]);
      await expect(
        runInDrizzleTransaction(db, async () => {
          const restoredNestedId = await store.ensureFolderPath(["before", "nested"]);
          await store.createDocumentRecordIfAbsent({
            id: DOC_AMBIENT_DELETE_ID,
            folderId: restoredNestedId,
            name: "chapter",
            extension: "",
            filetype: "markdown",
            markdown: "",
          });
          expect(await db.select().from(documentPreviousLocations)).toEqual([]);
          throw new Error("rollback claim");
        }),
      ).rejects.toThrow("rollback claim");
      expect(
        await db.select({ path: documentPreviousLocations.path }).from(documentPreviousLocations),
      ).toEqual([{ path: "before/nested/chapter" }]);
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
        extension: "",
        fileType: "markdown",
      });
      const path = [...names, "chapter"].join("/");
      const tree = new DrizzleContextTreeMutationStore(db);
      const source = await tree.inspect(SOURCE_ID, path);
      if (source?.kind !== "file") throw new Error("missing document");
      expect(
        await tree.commitMove({
          source,
          destinationSourceId: SOURCE_ID,
          destinationPath: "short",
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
          extension: "",
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
          extension: "",
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
      const stale = await tree.inspect(SOURCE_ID, "stale-delete");
      const rollbackToken = await tree.inspect(SOURCE_ID, "rollback-delete");
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
          extension: "",
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
            await expect(outerTree.inspect(sourceId, "parent/child")).resolves.toBeNull();
            throw outerFailure;
          }),
        ).rejects.toBe(outerFailure);
        await expect(outerTree.inspect(sourceId, "parent")).resolves.toMatchObject({
          nodeId: parentId,
        });
        await expect(outerTree.inspect(sourceId, "parent/child")).resolves.toMatchObject({
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

    it("serializes opposite-kind creation under the shared namespace lock", async () => {
      const left = new DrizzleContextDocumentStore({ db: committed, contextSourceId: sourceId });
      const right = new DrizzleContextDocumentStore({ db: probe, contextSourceId: sourceId });
      for (const [index, fileFirst] of [true, false, true, false].entries()) {
        const name = `Clash ${index}`;
        const file = () =>
          left.createDocument({
            folderId: null,
            name,
            extension: "",
            filetype: "markdown",
            markdown: "",
          });
        const folderName = index < 2 ? name : `${name}.md`;
        const folder = () => right.ensureFolderPath([folderName]);
        const results = await Promise.allSettled(
          fileFirst ? [file(), folder()] : [folder(), file()],
        );
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const rejected = results.find((result) => result.status === "rejected");
        expect(rejected?.status === "rejected" && rejected.reason.message).toBe(
          "Context entry already exists",
        );
        expect(
          (await left.listDocuments(LIVE_TREE, null)).filter((row) => row.name === name).length +
            (await left.listFolders(LIVE_TREE, null)).filter((row) => row.name === folderName)
              .length,
        ).toBe(1);
      }
    });

    it("a same-source move row-locks its document, and a journal FK insert still completes under it", async () => {
      const holder = randomUUID();
      await committed
        .insert(documents)
        .values({ id: holder, contextSourceId: sourceId, name: "holder", extension: "" });
      const persistence = createDrizzleCollabPersistence(committed);
      await persistence.lifecycle.ensureDocument(holder as never);
      const tree = new DrizzleContextTreeMutationStore(committed);
      const source = await tree.inspect(sourceId, "holder");
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
        destinationPath: "moved-holder",
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
}
