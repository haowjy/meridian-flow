/** PostgreSQL proof for catalog transaction, replay, exclusion, and wake semantics. */
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextCatalogCommits,
  contextSources,
  documentMarkdownProjections,
  documents,
  folders,
  projects,
  users,
  works,
} from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { Ok } from "../../../shared/result.js";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../../test-support/drizzle-reset.js";
import { createDrizzleWorkDraftPendingStore } from "../../collab/adapters/drizzle-branch-push.js";
import type { BindMarkdownInput } from "../../collab/index.js";
import { fakeBoundWrite } from "../../collab/test-support/bound-writes.js";
import { createTestDocumentLinkScopes } from "../../collab/test-support/document-link-scopes.js";
import { createLocalFileAccessChanges } from "../../file-policy/index.js";
import { createWorkProjectionMutation } from "../../projects/adapters/work-projection-mutation.js";
import { createDrizzleWorkRepository } from "../../projects/adapters/work-repository/drizzle.js";
import { createProjectRepositoryForTest as createDrizzleProjectRepository } from "../../projects/test-support/project-repository.js";
import { createProjectContextDocumentStore } from "../context-source-provisioning.js";
import { createDocumentAddressResolver } from "../document-address.js";
import { createDrizzleContextCatalog } from "./context-catalog.js";
import { ContextFS } from "./context-fs/context-fs.js";
import { DrizzleContextDocumentStore } from "./context-fs/drizzle-store.js";
import { DrizzleContextTreeMutationStore } from "./context-fs/drizzle-tree-mutation-store.js";
import { createDrizzleDocumentAddressStore } from "./document-address.js";
import { createDrizzleLineageScratchLifecycle } from "./lineage-scratch-lifecycle.js";
import { createDrizzleProjectContextAvailability } from "./project-context-availability.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("context catalog (postgres)", () => {});
} else {
  describe("context catalog (postgres)", () => {
    const USER_ID = "00000000-0000-4000-8000-000000000801";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000802";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000803";
    const DOCUMENT_ID = "00000000-0000-4000-8000-000000000804";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
    });
    async function seedProject(
      db: typeof database.current,
      label: string,
      sources: typeof contextSources.$inferInsert | (typeof contextSources.$inferInsert)[] = {
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
      },
    ) {
      await db.insert(users).values(conformanceUserValues(USER_ID, label));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Catalog Project",
        slug: "catalog-project",
      });
      const rows = Array.isArray(sources) ? sources : [sources];
      if (rows.length) await db.insert(contextSources).values(rows);
    }
    it("publishes atomically, replays whole commits, and keeps failed hints nonthrowing", async () => {
      const db = database.current;
      await seedProject(db, "catalog");
      const publish = vi.fn(async () => {
        throw new Error("offline");
      });
      const catalog = createDrizzleContextCatalog(db, { publish });
      const scope = { kind: "project", projectId: PROJECT_ID } as const;
      const before = await catalog.snapshot(scope);
      await expect(
        runInDrizzleTransaction(db, async () => {
          await currentDrizzleDb(db).insert(documents).values({
            id: DOCUMENT_ID,
            contextSourceId: SOURCE_ID,
            name: "chapter",
            extension: "",
          });
          await catalog.refreshSources([SOURCE_ID]);
          expect(publish).not.toHaveBeenCalled();
        }),
      ).resolves.toBeUndefined();
      expect(publish).toHaveBeenCalledTimes(1);
      const replay = await catalog.changes(scope, before.cursor);
      expect(replay.kind).toBe("delta");
      if (replay.kind !== "delta") return;
      expect(replay.commits).toHaveLength(1);
      expect(replay.commits[0]?.changes.some((change) => change.operation === "upsert")).toBe(true);
      await expect(catalog.lookup({ scope, entryId: DOCUMENT_ID })).resolves.toMatchObject({
        entry: { kind: "file", entryId: DOCUMENT_ID, uri: "manuscript://chapter" },
      });
    });
    it("republishes a moved subtree even when an earlier repair already published its new location", async () => {
      const db = database.current;
      await seedProject(db, "catalog-invalidation");
      const folderId = "00000000-0000-4000-8000-000000000805";
      await db.insert(folders).values({ id: folderId, contextSourceId: SOURCE_ID, name: "Arc" });
      await db.insert(documents).values({
        id: DOCUMENT_ID,
        contextSourceId: SOURCE_ID,
        folderId,
        name: "a",
        extension: "",
      });
      const catalog = createDrizzleContextCatalog(db);
      const scope = { kind: "project", projectId: PROJECT_ID } as const;
      await catalog.snapshot(scope);
      await db.update(documents).set({ name: "b" }).where(eq(documents.id, DOCUMENT_ID));
      await db.update(folders).set({ name: "Moved" }).where(eq(folders.id, folderId));
      // One repair can publish the move before its deferred root invalidation.
      await catalog.refreshSources([SOURCE_ID]);
      const moved = await catalog.snapshot(scope);
      await catalog.refreshSources([SOURCE_ID], [folderId]);
      const republished = await catalog.snapshot(scope);
      const replay = await catalog.changes(scope, moved.cursor);
      expect(replay.kind).toBe("delta");
      if (replay.kind !== "delta") throw new Error("Expected retained move commit");
      expect(replay.commits).toHaveLength(1);
      expect(replay.commits[0]?.changes).toEqual([
        { operation: "invalidate-subtree", ordinal: 0, rootEntryId: folderId },
        ...republished.entries
          .filter((entry) => entry.entryId === folderId || entry.entryId === DOCUMENT_ID)
          .map((entry, index) => ({ operation: "upsert", ordinal: index + 1, entry })),
      ]);
      expect(moved.entries.find((entry) => entry.entryId === DOCUMENT_ID)).toMatchObject({
        uri: "manuscript://Moved/b",
      });
      await db
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, DOCUMENT_ID));
      await catalog.refreshSources([SOURCE_ID], [DOCUMENT_ID]);
      const removed = await catalog.changes(scope, replay.nextCursor);
      expect(removed).toMatchObject({
        kind: "delta",
        commits: [
          {
            changes: [
              { operation: "invalidate-subtree", rootEntryId: DOCUMENT_ID },
              { operation: "upsert", entry: { entryId: folderId, hasChildren: false } },
              { operation: "delete", entryId: DOCUMENT_ID },
            ],
          },
        ],
      });
    });
    it("rolls catalog state back and excludes hidden rows and content-only changes", async () => {
      const db = database.current;
      await seedProject(db, "catalog-rollback");
      const catalog = createDrizzleContextCatalog(db);
      const scope = { kind: "project", projectId: PROJECT_ID } as const;
      const before = await catalog.snapshot(scope);
      await expect(
        runInDrizzleTransaction(db, async () => {
          await currentDrizzleDb(db).insert(documents).values({
            id: DOCUMENT_ID,
            contextSourceId: SOURCE_ID,
            name: "draft-only",
            extension: "json",
            hidden: true,
          });
          await catalog.refreshSources([SOURCE_ID]);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      const after = await catalog.snapshot(scope);
      expect(after.headRevision).toBe(before.headRevision);
      expect(after.entries.some((entry) => entry.entryId === DOCUMENT_ID)).toBe(false);
      const replay = await catalog.changes(scope, before.cursor);
      expect(replay).toMatchObject({ kind: "delta", commits: [] });
      const contentDocumentId = "00000000-0000-4000-8000-000000000806";
      await db.insert(documents).values({
        id: contentDocumentId,
        contextSourceId: SOURCE_ID,
        name: "content-only",
        extension: "",
        fileType: "markdown",
      });
      await catalog.refreshSources([SOURCE_ID]);
      const beforeContentWrite = await catalog.snapshot(scope);
      await db
        .insert(documentMarkdownProjections)
        .values({ documentId: contentDocumentId, markdown: "new words only" })
        .onConflictDoUpdate({
          target: documentMarkdownProjections.documentId,
          set: { markdown: "new words only" },
        });
      const afterContentWrite = await catalog.snapshot(scope);
      expect(afterContentWrite.headRevision).toBe(beforeContentWrite.headRevision);
      await expect(catalog.changes(scope, beforeContentWrite.cursor)).resolves.toMatchObject({
        kind: "delta",
        commits: [],
      });
    });
    it("preserves persisted tracked, binary, and custom classification", async () => {
      const db = database.current;
      await seedProject(db, "catalog-classification");
      await db.insert(documents).values([
        {
          contextSourceId: SOURCE_ID,
          name: "chapter",
          extension: "unknown",
          fileType: "markdown",
        },
        {
          contextSourceId: SOURCE_ID,
          name: "draft",
          extension: "unknown",
          fileType: "docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          storageUrl: "s3://draft",
        },
        {
          contextSourceId: SOURCE_ID,
          name: "cover",
          extension: "blob",
          fileType: "image",
          mimeType: "image/webp",
          storageUrl: "s3://cover",
        },
        {
          contextSourceId: SOURCE_ID,
          name: "proof",
          extension: "blob",
          fileType: "pdf",
          mimeType: "application/pdf",
          storageUrl: "s3://proof",
        },
        {
          contextSourceId: SOURCE_ID,
          name: "archive",
          extension: "txt",
          fileType: "binary",
          mimeType: "application/octet-stream",
          storageUrl: "s3://archive",
        },
        {
          contextSourceId: SOURCE_ID,
          name: "research",
          extension: "note",
          fileType: "notebook",
          storageUrl: "s3://research",
        },
      ]);
      const catalog = createDrizzleContextCatalog(db);
      const snapshot = await catalog.snapshot({ kind: "project", projectId: PROJECT_ID });
      const files = snapshot.entries.filter((entry) => entry.kind === "file");
      expect(files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "chapter.unknown",
            editable: true,
            filetype: "markdown",
          }),
          expect.objectContaining({ name: "draft.unknown", editable: false, fileType: "docx" }),
          expect.objectContaining({ name: "cover.blob", editable: false, fileType: "image" }),
          expect.objectContaining({ name: "proof.blob", editable: false, fileType: "pdf" }),
          expect.objectContaining({ name: "archive.txt", editable: false, fileType: "binary" }),
          expect.objectContaining({
            name: "research.note",
            editable: false,
            disposition: "custom",
            fileType: "binary",
            filetype: "notebook",
          }),
        ]),
      );
    });
    it("keeps historical replay versions below newer exact-ID and snapshot observations", async () => {
      const db = database.current;
      await seedProject(db, "catalog-freshness");
      await db
        .insert(documents)
        .values({ id: DOCUMENT_ID, contextSourceId: SOURCE_ID, name: "Start", extension: "md" });
      const catalog = createDrizzleContextCatalog(db);
      const scope = { kind: "project" as const, projectId: PROJECT_ID };
      await catalog.refreshSources([SOURCE_ID]);
      const before = await catalog.snapshot(scope);
      await db.update(documents).set({ name: "Historical" }).where(eq(documents.id, DOCUMENT_ID));
      await catalog.refreshSources([SOURCE_ID]);
      const historical = await catalog.snapshot(scope);
      const historicalEntry = historical.entries.find((entry) => entry.entryId === DOCUMENT_ID);
      if (historicalEntry?.kind !== "file") throw new Error("Missing historical entry");
      const historicalVersion = historicalEntry.observationVersion;
      await db.update(documents).set({ name: "Newest" }).where(eq(documents.id, DOCUMENT_ID));
      await catalog.refreshSources([SOURCE_ID]);
      const newest = await catalog.snapshot(scope);
      const newestEntry = newest.entries.find((entry) => entry.entryId === DOCUMENT_ID);
      if (newestEntry?.kind !== "file") throw new Error("Missing newest entry");
      const newestVersion = newestEntry.observationVersion;
      const available = await createDrizzleProjectContextAvailability(db).lookup(
        { projectId: PROJECT_ID, documentIds: [DOCUMENT_ID] },
        { userId: USER_ID },
      );
      const resolution = available.resolutions[0];
      expect(resolution).toMatchObject({
        kind: "available",
        entry: { name: "Newest.md", observationVersion: newestVersion },
      });
      const snapshot = await catalog.snapshot(scope);
      expect(snapshot.entries.find((entry) => entry.entryId === DOCUMENT_ID)).toMatchObject({
        observationVersion: newestVersion,
      });
      const page = await catalog.changes(scope, before.cursor, 1);
      if (page.kind !== "delta") throw new Error("Expected replay");
      expect(page.hasMore).toBe(true);
      const change = page.commits[0]?.changes.find(
        (change) => change.operation === "upsert" && change.entry.entryId === DOCUMENT_ID,
      );
      expect(change).toMatchObject({
        operation: "upsert",
        entry: { name: "Historical.md", observationVersion: historicalVersion },
      });
      expect(BigInt(historicalVersion)).toBeLessThan(BigInt(newestVersion));
    });
    it("rolls real ContextFS metadata and its catalog commit back together", async () => {
      const db = database.current;
      await seedProject(db, "catalog-contextfs-rollback");
      const catalog = createDrizzleContextCatalog(db);
      const before = await catalog.snapshot({ kind: "project", projectId: PROJECT_ID });
      const failingCatalog = {
        refreshProject: (projectId: string) => catalog.refreshProject(projectId),
        async refreshSources(sourceIds: readonly string[], invalidated?: readonly string[]) {
          await catalog.refreshSources(sourceIds, invalidated);
          throw new Error("catalog failure");
        },
      };
      const store = new DrizzleContextDocumentStore({
        db,
        contextSourceId: SOURCE_ID,
        catalogMutations: failingCatalog,
      });
      const context = new ContextFS({
        placement: { kind: "live" },
        holder: { projectId: PROJECT_ID },
        links: createTestDocumentLinkScopes(db),
        store,
        mutationStore: new DrizzleContextTreeMutationStore(db, failingCatalog),
        scheme: "manuscript",
        documentSync: {
          ensureDocument: async () => {},
          readAsMarkdown: async () => Ok(""),
          bindMarkdown: async (input: BindMarkdownInput) => fakeBoundWrite(input),
          seedFromMarkdown: async () => Ok({ updateSeq: 1 }),
        } as never,
      });
      await expect(context.mkdir("Rolled Back/Nested")).rejects.toThrow("catalog failure");
      await expect(
        db.select().from(folders).where(eq(folders.contextSourceId, SOURCE_ID)),
      ).resolves.toEqual([]);
      await expect(
        catalog.changes({ kind: "project", projectId: PROJECT_ID }, before.cursor),
      ).resolves.toMatchObject({ kind: "delta", commits: [] });
    });
    it("rolls back first-touch source publication with the real ContextFS command", async () => {
      const db = database.current;
      await seedProject(db, "catalog-source-rollback", []);
      const catalog = createDrizzleContextCatalog(db);
      let refreshCalls = 0;
      let failMutationRefresh = true;
      const failingCatalog = {
        refreshProject: (projectId: string) => catalog.refreshProject(projectId),
        async refreshSources(sourceIds: readonly string[]) {
          refreshCalls += 1;
          const generation = await catalog.refreshSources(sourceIds);
          if (failMutationRefresh && refreshCalls === 2) throw new Error("catalog failure");
          return generation;
        },
      };
      const store = createProjectContextDocumentStore(
        db,
        PROJECT_ID,
        "kb",
        USER_ID,
        failingCatalog,
      );
      const context = new ContextFS({
        placement: { kind: "live" },
        holder: { projectId: PROJECT_ID },
        links: createTestDocumentLinkScopes(db),
        store,
        mutationStore: new DrizzleContextTreeMutationStore(db, failingCatalog),
        scheme: "kb",
        documentSync: {
          ensureDocument: async () => {},
          readAsMarkdown: async () => Ok(""),
          bindMarkdown: async (input: BindMarkdownInput) => fakeBoundWrite(input),
          seedFromMarkdown: async () => Ok({ updateSeq: 1 }),
        } as never,
      });
      await expect(context.mkdir("Rolled Back")).rejects.toThrow("catalog failure");
      await expect(
        db
          .select()
          .from(contextSources)
          .where(
            and(
              eq(contextSources.projectId, PROJECT_ID),
              eq(contextSources.slug, "kb"),
              isNull(contextSources.deletedAt),
            ),
          ),
      ).resolves.toEqual([]);
      await expect(db.select().from(folders)).resolves.toEqual([]);
      failMutationRefresh = false;
      refreshCalls = 0;
      await expect(context.mkdir("Retry")).resolves.toMatchObject({ ok: true });
      await expect(
        db
          .select()
          .from(contextSources)
          .where(and(eq(contextSources.projectId, PROJECT_ID), eq(contextSources.slug, "kb"))),
      ).resolves.toHaveLength(1);
    });
    it("rolls project lifecycle and catalog revocation back at the repository seam", async () => {
      const db = database.current;
      await seedProject(db, "catalog-project-rollback", []);
      const catalog = createDrizzleContextCatalog(db);
      const repository = createDrizzleProjectRepository({
        db,
        catalogLifecycle: {
          async upsertWorkAuthorities() {},
          async refreshProject(projectId) {
            await catalog.refreshProject(projectId);
            throw new Error("catalog failure");
          },
        },
      });
      await expect(repository.softDelete(PROJECT_ID)).rejects.toThrow("catalog failure");
      await expect(repository.findById(PROJECT_ID)).resolves.toMatchObject({ deletedAt: null });
    });
    it("projects successful Work lifecycle transitions and rolls refresh failure back", async () => {
      const db = database.current;
      await seedProject(db, "catalog-work-lifecycle", []);
      const catalog = createDrizzleContextCatalog(db);
      const availability = createDrizzleProjectContextAvailability(db);
      const repository = createDrizzleWorkRepository({
        lineageScratch: createDrizzleLineageScratchLifecycle(db),
        db,
        fileAccessChanges: createLocalFileAccessChanges(),
        projectionMutation: createWorkProjectionMutation({
          db,
          availability,
          catalog,
          pending: createDrizzleWorkDraftPendingStore(db),
        }),
      });
      const workId = "00000000-0000-4000-8000-000000000807" as never;
      const scope = { kind: "project", projectId: PROJECT_ID } as const;
      await repository.create({
        id: workId,
        projectId: PROJECT_ID as never,
        createdByUserId: USER_ID as never,
        name: "Lifecycle Work",
      });
      const authority = async () =>
        (await catalog.snapshot(scope)).entries.find((entry) => entry.entryId === workId);
      await expect(authority()).resolves.toMatchObject({
        kind: "authority",
        available: true,
        entityRevision: "1",
      });
      await repository.archive(workId);
      await expect(authority()).resolves.toMatchObject({ available: false, entityRevision: "2" });
      await repository.unarchive(workId);
      await expect(authority()).resolves.toMatchObject({ available: true, entityRevision: "3" });
      await repository.softDelete(workId);
      await expect(authority()).resolves.toMatchObject({ available: false, entityRevision: "4" });
      await repository.restore(workId);
      await expect(authority()).resolves.toMatchObject({ available: true, entityRevision: "5" });
      const failingRepository = createDrizzleWorkRepository({
        lineageScratch: createDrizzleLineageScratchLifecycle(db),
        db,
        fileAccessChanges: createLocalFileAccessChanges(),
        projectionMutation: createWorkProjectionMutation({
          db,
          pending: createDrizzleWorkDraftPendingStore(db),
          availability,
          catalog: {
            async refreshProject(projectId) {
              await catalog.refreshProject(projectId);
            },
            async upsertWorkAuthorities(workIds) {
              await catalog.upsertWorkAuthorities(workIds);
              throw new Error("catalog failure");
            },
          },
        }),
      });
      await expect(failingRepository.archive(workId)).rejects.toThrow("catalog failure");
      await expect(repository.findById(workId)).resolves.toMatchObject({ status: null });
      await expect(authority()).resolves.toMatchObject({ available: true });
    });
    it("publishes provisional graduation and keeps canonical URI lookup scheme-qualified", async () => {
      const db = database.current;
      await seedProject(db, "catalog-graduation", []);
      const KB_SOURCE_ID = "00000000-0000-4000-8000-000000000805";
      await db.insert(contextSources).values([
        { id: SOURCE_ID, projectId: PROJECT_ID, name: "Manuscript", slug: "manuscript" },
        { id: KB_SOURCE_ID, projectId: PROJECT_ID, name: "Knowledge Base", slug: "kb" },
      ]);
      await db.insert(documents).values([
        {
          id: DOCUMENT_ID,
          contextSourceId: SOURCE_ID,
          name: "notes",
          extension: "",
          fileType: "markdown",
          provisionalName: true,
        },
        {
          contextSourceId: KB_SOURCE_ID,
          name: "notes",
          extension: "",
          fileType: "markdown",
        },
      ]);
      const catalog = createDrizzleContextCatalog(db);
      await catalog.refreshSources([SOURCE_ID, KB_SOURCE_ID]);
      const scope = { kind: "project", projectId: PROJECT_ID } as const;
      const before = await catalog.snapshot(scope);
      const mutationStore = new DrizzleContextTreeMutationStore(db, catalog);
      await expect(
        mutationStore.commitProvisionalGraduation({
          kind: "file",
          nodeId: DOCUMENT_ID,
          sourceId: SOURCE_ID,
          path: "notes",
          filetype: "markdown",
        }),
      ).resolves.toMatchObject({ ok: true });
      const replay = await catalog.changes(scope, before.cursor);
      expect(replay).toMatchObject({
        kind: "delta",
        commits: [
          {
            changes: expect.arrayContaining([
              expect.objectContaining({
                operation: "upsert",
                entry: expect.objectContaining({ entryId: DOCUMENT_ID, provisionalName: false }),
              }),
            ]),
          },
        ],
      });
      await expect(catalog.lookup({ scope, uri: "manuscript://notes" })).resolves.toMatchObject({
        entry: { entryId: DOCUMENT_ID },
      });
      await expect(catalog.lookup({ scope, uri: "kb://notes" })).resolves.toMatchObject({
        entry: { kind: "file", uri: "kb://notes" },
      });
    });
    it("returns explicit expired and gap resets after PostgreSQL retention or missing history", async () => {
      const db = database.current;
      await seedProject(db, "catalog-retention");
      const scope = { kind: "project", projectId: PROJECT_ID } as const;
      const catalog = createDrizzleContextCatalog(db, undefined, { retainedCommitsPerScope: 1 });
      const oldest = await catalog.snapshot(scope);
      await db.insert(documents).values({
        id: DOCUMENT_ID,
        contextSourceId: SOURCE_ID,
        name: "one",
        extension: "",
        fileType: "markdown",
      });
      await catalog.refreshSources([SOURCE_ID]);
      const middle = await catalog.snapshot(scope);
      await db.update(documents).set({ name: "two" }).where(eq(documents.id, DOCUMENT_ID));
      await catalog.refreshSources([SOURCE_ID]);
      await expect(catalog.changes(scope, oldest.cursor)).resolves.toMatchObject({
        kind: "reset-required",
        reason: "expired",
      });
      await db.delete(contextCatalogCommits);
      await expect(catalog.changes(scope, middle.cursor)).resolves.toMatchObject({
        kind: "reset-required",
        reason: "gap",
      });
    });
    it("returns canonical Work files until the Work is deleted", async () => {
      const db = database.current;
      const NO_WORK = "00000000-0000-4000-8000-000000000808";
      const NAMED = "00000000-0000-4000-8000-000000000809";
      const UPLOADS = "00000000-0000-4000-8000-00000000080b";
      const NAMED_SCRATCH = "00000000-0000-4000-8000-00000000080c";
      const FILE = "00000000-0000-4000-8000-00000000080d";
      const UPLOAD_FILE = "00000000-0000-4000-8000-00000000080e";
      const NAMED_FILE = "00000000-0000-4000-8000-00000000080f";
      await seedProject(db, "catalog-no-work", []);
      await db.insert(works).values([
        {
          id: NO_WORK,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "No Work",
          slug: null,
          isNoWork: true,
        },
        {
          id: NAMED,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Draft",
          slug: "draft",
        },
      ]);
      await db.insert(contextSources).values([
        { id: UPLOADS, workId: NO_WORK, scope: "work", name: "Uploads", slug: "uploads" },
        {
          id: NAMED_SCRATCH,
          workId: NAMED,
          scope: "work",
          name: "Scratch",
          slug: "scratch",
        },
      ]);
      await db.insert(documents).values([
        { id: FILE, contextSourceId: UPLOADS, name: "notes", extension: "" },
        {
          id: UPLOAD_FILE,
          contextSourceId: UPLOADS,
          name: "shot",
          extension: "png",
          fileType: "image",
        },
        { id: NAMED_FILE, contextSourceId: NAMED_SCRATCH, name: "arc", extension: "" },
      ]);
      const catalog = createDrizzleContextCatalog(db);
      const fileUris = async (scope: { kind: "work"; projectId: string; workId: string }) =>
        (await catalog.snapshot(scope)).entries
          .flatMap((entry) => (entry.kind === "file" ? [entry.uri] : []))
          .sort();
      expect(
        await fileUris({
          kind: "work",
          projectId: PROJECT_ID,
          workId: NO_WORK,
        }),
      ).toEqual(["uploads://@/notes", "uploads://@/shot.png"]);
      expect(await fileUris({ kind: "work", projectId: PROJECT_ID, workId: NAMED })).toEqual([
        "scratch://@draft/arc",
      ]);
      await db.update(works).set({ archivedAt: new Date() }).where(eq(works.id, NAMED));
      expect(await fileUris({ kind: "work", projectId: PROJECT_ID, workId: NAMED })).toEqual([
        "scratch://@draft/arc",
      ]);
      const namedAddress = () =>
        createDocumentAddressResolver({
          locations: createDrizzleDocumentAddressStore(db),
          availability: createDrizzleProjectContextAvailability(db),
        }).resolve({
          projectId: PROJECT_ID as never,
          userId: USER_ID,
          scheme: "scratch",
          workId: NAMED,
          path: "/arc",
        });
      await expect(namedAddress()).resolves.toMatchObject({
        kind: "current",
        document: {
          documentId: NAMED_FILE,
          authority: { kind: "work", projectId: PROJECT_ID, workId: NAMED },
          entry: { uri: "scratch://@draft/arc" },
        },
      });
      await db.update(works).set({ deletedAt: new Date() }).where(eq(works.id, NAMED));
      expect(await fileUris({ kind: "work", projectId: PROJECT_ID, workId: NAMED })).toEqual([]);
      await expect(namedAddress()).resolves.toEqual({ kind: "unavailable" });
      await expect(
        createDrizzleDocumentAddressStore(db).candidate({
          projectId: PROJECT_ID as never,
          userId: USER_ID,
          scheme: "uploads",
          workId: NO_WORK,
          path: "/notes",
        }),
      ).resolves.toMatchObject({ kind: "current", documentId: FILE });
    });
  });
}
