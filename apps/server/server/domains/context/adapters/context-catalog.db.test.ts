/** PostgreSQL proof for catalog transaction, replay, exclusion, and wake semantics. */
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextCatalogCommits,
  contextSources,
  documents,
  folders,
  projects,
  users,
} from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { Ok } from "../../../shared/result.js";
import { truncateDrizzleTables } from "../../../test-support/drizzle-reset.js";
import { useRollbackTestDatabase } from "../../../test-support/rollback-test-database.js";
import { createDrizzleProjectRepository } from "../../projects/adapters/project-repository/drizzle.js";
import { createWorkProjectionMutation } from "../../projects/adapters/work-projection-mutation.js";
import { createDrizzleWorkRepository } from "../../projects/adapters/work-repository/drizzle.js";
import { createProjectContextDocumentStore } from "../context-source-provisioning.js";
import { createDrizzleContextCatalog } from "./context-catalog.js";
import { ContextFS } from "./context-fs/context-fs.js";
import { DrizzleContextDocumentStore } from "./context-fs/drizzle-store.js";
import { DrizzleContextTreeMutationStore } from "./context-fs/drizzle-tree-mutation-store.js";
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
      prepareSuite: (db) => truncateDrizzleTables(db, [users]),
    });

    it("publishes atomically, replays whole commits, and keeps failed hints nonthrowing", async () => {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(USER_ID, "catalog"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Catalog Project",
        slug: "catalog-project",
      });
      await db.insert(contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
      });
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
            extension: "md",
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
        entry: { kind: "file", entryId: DOCUMENT_ID, uri: "manuscript://chapter.md" },
      });
    });

    it("rolls catalog state back and excludes manifests and content-only changes", async () => {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(USER_ID, "catalog-rollback"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Catalog Project",
        slug: "catalog-project",
      });
      await db.insert(contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
      });
      const catalog = createDrizzleContextCatalog(db);
      const scope = { kind: "project", projectId: PROJECT_ID } as const;
      const before = await catalog.snapshot(scope);
      await expect(
        runInDrizzleTransaction(db, async () => {
          await currentDrizzleDb(db).insert(documents).values({
            id: DOCUMENT_ID,
            contextSourceId: SOURCE_ID,
            name: "manifest",
            extension: "json",
            kind: "manifest",
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
        extension: "md",
        fileType: "markdown",
      });
      await catalog.refreshSources([SOURCE_ID]);
      const beforeContentWrite = await catalog.snapshot(scope);
      const store = new DrizzleContextDocumentStore({
        db,
        contextSourceId: SOURCE_ID,
        catalogMutations: catalog,
      });
      await store.updateDocumentProjection(contentDocumentId, "new words only");
      const afterContentWrite = await catalog.snapshot(scope);
      expect(afterContentWrite.headRevision).toBe(beforeContentWrite.headRevision);
      await expect(catalog.changes(scope, beforeContentWrite.cursor)).resolves.toMatchObject({
        kind: "delta",
        commits: [],
      });
    });

    it("preserves persisted tracked, binary, and custom classification", async () => {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(USER_ID, "catalog-classification"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Catalog Project",
        slug: "catalog-project",
      });
      await db.insert(contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
      });
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

    it("rolls real ContextFS metadata and its catalog commit back together", async () => {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(USER_ID, "catalog-contextfs-rollback"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Catalog Project",
        slug: "catalog-project",
      });
      await db.insert(contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
      });
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
        store,
        mutationStore: new DrizzleContextTreeMutationStore(db, undefined, failingCatalog),
        scheme: "manuscript",
        documentSync: {
          ensureDocument: async () => {},
          readAsMarkdown: async () => Ok(""),
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
      await db.insert(users).values(conformanceUserValues(USER_ID, "catalog-source-rollback"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Catalog Project",
        slug: "catalog-project",
      });
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
        "scratch",
        USER_ID,
        undefined,
        failingCatalog,
      );
      const context = new ContextFS({
        store,
        mutationStore: new DrizzleContextTreeMutationStore(db, undefined, failingCatalog),
        scheme: "scratch",
        documentSync: {
          ensureDocument: async () => {},
          readAsMarkdown: async () => Ok(""),
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
              eq(contextSources.slug, "scratch"),
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
          .where(and(eq(contextSources.projectId, PROJECT_ID), eq(contextSources.slug, "scratch"))),
      ).resolves.toHaveLength(1);
    });

    it("rolls project lifecycle and catalog revocation back at the repository seam", async () => {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(USER_ID, "catalog-project-rollback"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Catalog Project",
        slug: "catalog-project",
      });
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
      await db.insert(users).values(conformanceUserValues(USER_ID, "catalog-work-lifecycle"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Catalog Project",
        slug: "catalog-project",
      });
      const catalog = createDrizzleContextCatalog(db);
      const availability = createDrizzleProjectContextAvailability(db);
      const repository = createDrizzleWorkRepository({
        db,
        hasUnreviewedDraft: async () => false,
        projectionMutation: createWorkProjectionMutation({ db, availability, catalog }),
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
        db,
        hasUnreviewedDraft: async () => false,
        projectionMutation: createWorkProjectionMutation({
          db,
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
      await expect(repository.findById(workId)).resolves.toMatchObject({ status: "active" });
      await expect(authority()).resolves.toMatchObject({ available: true });
    });

    it("publishes provisional graduation and keeps canonical URI lookup scheme-qualified", async () => {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(USER_ID, "catalog-graduation"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Catalog Project",
        slug: "catalog-project",
      });
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
          extension: "md",
          fileType: "markdown",
          provisionalName: true,
        },
        {
          contextSourceId: KB_SOURCE_ID,
          name: "notes",
          extension: "md",
          fileType: "markdown",
        },
      ]);
      const catalog = createDrizzleContextCatalog(db);
      await catalog.refreshSources([SOURCE_ID, KB_SOURCE_ID]);
      const scope = { kind: "project", projectId: PROJECT_ID } as const;
      const before = await catalog.snapshot(scope);
      const mutationStore = new DrizzleContextTreeMutationStore(db, undefined, catalog);
      await expect(
        mutationStore.commitProvisionalGraduation({
          kind: "file",
          nodeId: DOCUMENT_ID,
          sourceId: SOURCE_ID,
          path: "notes.md",
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
      await expect(catalog.lookup({ scope, uri: "manuscript://notes.md" })).resolves.toMatchObject({
        entry: { entryId: DOCUMENT_ID },
      });
      await expect(catalog.lookup({ scope, uri: "kb://notes.md" })).resolves.toMatchObject({
        entry: { kind: "file", uri: "kb://notes.md" },
      });
    });

    it("returns explicit expired and gap resets after PostgreSQL retention or missing history", async () => {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(USER_ID, "catalog-retention"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Catalog Project",
        slug: "catalog-project",
      });
      await db.insert(contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
      });
      const scope = { kind: "project", projectId: PROJECT_ID } as const;
      const catalog = createDrizzleContextCatalog(db, undefined, { retainedCommitsPerScope: 1 });
      const oldest = await catalog.snapshot(scope);
      await db.insert(documents).values({
        id: DOCUMENT_ID,
        contextSourceId: SOURCE_ID,
        name: "one",
        extension: "md",
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
  });
}
