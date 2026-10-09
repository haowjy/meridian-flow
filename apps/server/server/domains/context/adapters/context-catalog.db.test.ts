/** PostgreSQL proof for catalog transaction, replay, exclusion, and wake semantics. */
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextAvailabilityHeads,
  contextCatalogCommits,
  contextCatalogEntries,
  contextSources,
  documents,
  folders,
  projects,
  users,
  works,
} from "@meridian/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { Ok } from "../../../shared/result.js";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../../test-support/drizzle-reset.js";
import type { BindMarkdownInput } from "../../collab/index.js";
import { fakeBoundWrite } from "../../collab/test-support/bound-writes.js";
import { createTestDocumentLinkScopes } from "../../collab/test-support/document-link-scopes.js";
import { createLocalFileAccessChanges } from "../../file-policy/index.js";
import { createInMemoryEventSink } from "../../observability/index.js";
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

    it("publishes only live manuscript membership while leaving other project sources unchanged", async () => {
      const db = database.current;
      const LIVE_DOCUMENT_ID = "00000000-0000-4000-8000-000000000805";
      const DRAFT_DOCUMENT_ID = "00000000-0000-4000-8000-000000000806";
      const KB_SOURCE_ID = "00000000-0000-4000-8000-000000000807";
      const KB_DOCUMENT_ID = "00000000-0000-4000-8000-000000000808";
      await seedProject(db, "catalog-membership", [
        { id: SOURCE_ID, projectId: PROJECT_ID, name: "Manuscript", slug: "manuscript" },
        { id: KB_SOURCE_ID, projectId: PROJECT_ID, name: "Knowledge Base", slug: "kb" },
      ]);
      await db.insert(documents).values([
        {
          id: LIVE_DOCUMENT_ID,
          contextSourceId: SOURCE_ID,
          name: "live",
          extension: "md",
        },
        {
          id: DRAFT_DOCUMENT_ID,
          contextSourceId: SOURCE_ID,
          name: "draft-only",
          extension: "md",
        },
        {
          id: KB_DOCUMENT_ID,
          contextSourceId: KB_SOURCE_ID,
          name: "notes",
          extension: "md",
        },
      ]);
      const members = new Set([LIVE_DOCUMENT_ID]);
      let membershipFailure = false;
      const eventSink = createInMemoryEventSink();
      const delay = vi.fn(async (_ms: number) => {});
      const publish = vi.fn();
      const catalog = createDrizzleContextCatalog(
        db,
        { publish },
        {
          delay,
          eventSink,
          manifestMembership: {
            async resolveManifestMembership() {
              if (membershipFailure) throw new Error("membership unavailable");
              return {
                documentId: "00000000-0000-4000-8000-000000000809" as never,
                members: [...members],
              };
            },
          },
        },
      );
      const scope = { kind: "project", projectId: PROJECT_ID } as const;
      const initial = await catalog.snapshot(scope);
      const initialFileIds = initial.entries.flatMap((entry) =>
        entry.kind === "file" ? [entry.entryId] : [],
      );
      expect(initialFileIds).toEqual(expect.arrayContaining([LIVE_DOCUMENT_ID, KB_DOCUMENT_ID]));
      expect(initialFileIds).not.toContain(DRAFT_DOCUMENT_ID);

      members.add(DRAFT_DOCUMENT_ID);
      await catalog.refreshProject(PROJECT_ID);
      await expect(catalog.changes(scope, initial.cursor)).resolves.toMatchObject({
        kind: "delta",
        commits: [
          {
            changes: expect.arrayContaining([
              expect.objectContaining({
                operation: "upsert",
                entry: expect.objectContaining({ entryId: DRAFT_DOCUMENT_ID }),
              }),
            ]),
          },
        ],
      });
      expect(publish).toHaveBeenCalledTimes(1);

      const applied = await catalog.snapshot(scope);
      members.delete(DRAFT_DOCUMENT_ID);
      await catalog.refreshProject(PROJECT_ID);
      await expect(catalog.changes(scope, applied.cursor)).resolves.toMatchObject({
        kind: "delta",
        commits: [
          {
            changes: expect.arrayContaining([
              expect.objectContaining({ operation: "delete", entryId: DRAFT_DOCUMENT_ID }),
            ]),
          },
        ],
      });
      const discarded = await catalog.snapshot(scope);
      const discardedFileIds = discarded.entries.flatMap((entry) =>
        entry.kind === "file" ? [entry.entryId] : [],
      );
      expect(discardedFileIds).toEqual(expect.arrayContaining([LIVE_DOCUMENT_ID, KB_DOCUMENT_ID]));
      expect(discardedFileIds).not.toContain(DRAFT_DOCUMENT_ID);
      expect(publish).toHaveBeenCalledTimes(2);

      const persistedBeforeFailure = await db
        .select()
        .from(contextCatalogEntries)
        .where(eq(contextCatalogEntries.scopeKey, `project:${PROJECT_ID}`));
      const availabilityBeforeFailure = await db
        .select()
        .from(contextAvailabilityHeads)
        .where(eq(contextAvailabilityHeads.authorityKey, `project:${PROJECT_ID}`));
      membershipFailure = true;
      await expect(catalog.refreshProjectDocuments(PROJECT_ID)).resolves.toBeUndefined();
      expect(delay.mock.calls.map(([ms]) => ms)).toEqual([10, 50, 250, 1_000]);
      expect(eventSink.events).toContainEqual(
        expect.objectContaining({ name: "DeferredRefreshFailure", level: "error" }),
      );
      await expect(
        db
          .select()
          .from(contextCatalogEntries)
          .where(eq(contextCatalogEntries.scopeKey, `project:${PROJECT_ID}`)),
      ).resolves.toEqual(persistedBeforeFailure);
      await expect(
        db
          .select()
          .from(contextAvailabilityHeads)
          .where(eq(contextAvailabilityHeads.authorityKey, `project:${PROJECT_ID}`)),
      ).resolves.toEqual(availabilityBeforeFailure);
    });

    it("retries a post-Apply document refresh after the availability lock timeout", async () => {
      const db = database.current;
      const NEW_DOCUMENT_ID = "00000000-0000-4000-8000-000000000805";
      await seedProject(db, "catalog-apply-retry");
      const members = new Set<string>();
      const catalog = createDrizzleContextCatalog(db, undefined, {
        manifestMembership: {
          async resolveManifestMembership() {
            return {
              documentId: "00000000-0000-4000-8000-000000000809" as never,
              members: [...members],
            };
          },
        },
      });
      const scope = { kind: "project", projectId: PROJECT_ID } as const;
      await catalog.snapshot(scope);
      await db.insert(documents).values({
        id: NEW_DOCUMENT_ID,
        contextSourceId: SOURCE_ID,
        name: "new-chapter",
        extension: "md",
      });
      members.add(NEW_DOCUMENT_ID);

      const lockDb = createDb(DATABASE_URL, { max: 1 });
      let releaseLock!: () => void;
      let lockAcquired!: () => void;
      const acquired = new Promise<void>((resolve) => {
        lockAcquired = resolve;
      });
      const held = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const lockTask = lockDb.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(1296387666, 1096174676)`);
        lockAcquired();
        await held;
      });
      await acquired;
      const releaseTimer = setTimeout(releaseLock, 350);
      try {
        await catalog.refreshProjectDocuments(PROJECT_ID);
      } finally {
        clearTimeout(releaseTimer);
        releaseLock();
        await lockTask;
        await lockDb.close();
      }

      const snapshot = await catalog.snapshot(scope);
      expect(snapshot.entries).toContainEqual(
        expect.objectContaining({ kind: "file", entryId: NEW_DOCUMENT_ID }),
      );
    });

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

    it("does not expose a reserved generation when deferred Manuscript repair fails", async () => {
      const db = database.current;
      await seedProject(db, "catalog-deferred-failure");
      await db.insert(documents).values({
        id: DOCUMENT_ID,
        contextSourceId: SOURCE_ID,
        name: "chapter",
        extension: "md",
      });
      let failMembership = false;
      let resolveFailed!: () => void;
      const failed = new Promise<void>((resolve) => {
        resolveFailed = resolve;
      });
      const delay = vi.fn(async (_ms: number) => {});
      const eventSink = createInMemoryEventSink();
      const emit = eventSink.emit.bind(eventSink);
      eventSink.emit = (event) => {
        emit(event);
        if (event.name === "DeferredRefreshFailure") resolveFailed();
      };
      const availability = createDrizzleProjectContextAvailability(db, eventSink);
      const catalog = createDrizzleContextCatalog(db, undefined, {
        availabilityMutations: availability,
        eventSink,
        delay,
        manifestMembership: {
          async resolveManifestMembership() {
            if (failMembership) throw new Error("manifest offline");
            return {
              documentId: "00000000-0000-4000-8000-000000000809" as never,
              members: [DOCUMENT_ID],
            };
          },
        },
      });
      await catalog.refreshProjectDocuments(PROJECT_ID);
      const beforeEntries = await db.select().from(contextCatalogEntries);
      const beforeHeads = await db.select().from(contextAvailabilityHeads);

      delay.mockClear();
      failMembership = true;
      await runInDrizzleTransaction(db, async () => {
        await currentDrizzleDb(db)
          .update(documents)
          .set({ name: "renamed" })
          .where(eq(documents.id, DOCUMENT_ID));
        await catalog.refreshSources([SOURCE_ID]);
      });

      await failed;
      expect(delay.mock.calls.map(([ms]) => ms)).toEqual([10, 50, 250, 1_000]);
      await expect(db.select().from(contextCatalogEntries)).resolves.toEqual(beforeEntries);
      await expect(db.select().from(contextAvailabilityHeads)).resolves.toEqual(beforeHeads);
      expect(eventSink.events).toContainEqual(
        expect.objectContaining({
          source: "context-catalog",
          name: "DeferredRefreshFailure",
          level: "error",
        }),
      );
    });

    it("rolls catalog state back and excludes manifests and content-only changes", async () => {
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
      await db
        .update(documents)
        .set({ markdownProjection: "new words only" })
        .where(eq(documents.id, contentDocumentId));
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
        holder: { projectId: PROJECT_ID },
        links: createTestDocumentLinkScopes(db),
        store,
        mutationStore: new DrizzleContextTreeMutationStore(db, undefined, failingCatalog),
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
        undefined,
        failingCatalog,
      );
      const context = new ContextFS({
        holder: { projectId: PROJECT_ID },
        links: createTestDocumentLinkScopes(db),
        store,
        mutationStore: new DrizzleContextTreeMutationStore(db, undefined, failingCatalog),
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
        db,
        fileAccessChanges: createLocalFileAccessChanges(),
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
        fileAccessChanges: createLocalFileAccessChanges(),
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
      await seedProject(db, "catalog-retention");
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

    it("returns canonical Work files until the Work is deleted", async () => {
      const db = database.current;
      const NO_WORK = "00000000-0000-4000-8000-000000000808";
      const NAMED = "00000000-0000-4000-8000-000000000809";
      const SCRATCH = "00000000-0000-4000-8000-00000000080a";
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
        { id: SCRATCH, workId: NO_WORK, scope: "work", name: "Scratch", slug: "scratch" },
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
        { id: FILE, contextSourceId: SCRATCH, name: "notes", extension: "md" },
        {
          id: UPLOAD_FILE,
          contextSourceId: UPLOADS,
          name: "shot",
          extension: "png",
          fileType: "image",
        },
        { id: NAMED_FILE, contextSourceId: NAMED_SCRATCH, name: "arc", extension: "md" },
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
      ).toEqual(["scratch://@/notes.md", "uploads://@/shot.png"]);
      expect(await fileUris({ kind: "work", projectId: PROJECT_ID, workId: NAMED })).toEqual([
        "scratch://@draft/arc.md",
      ]);

      await db.update(works).set({ archivedAt: new Date() }).where(eq(works.id, NAMED));
      expect(await fileUris({ kind: "work", projectId: PROJECT_ID, workId: NAMED })).toEqual([
        "scratch://@draft/arc.md",
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
          path: "/arc.md",
        });
      await expect(namedAddress()).resolves.toMatchObject({
        kind: "current",
        document: {
          documentId: NAMED_FILE,
          authority: { kind: "work", projectId: PROJECT_ID, workId: NAMED },
          entry: { uri: "scratch://@draft/arc.md" },
        },
      });

      await db.update(works).set({ deletedAt: new Date() }).where(eq(works.id, NAMED));
      expect(await fileUris({ kind: "work", projectId: PROJECT_ID, workId: NAMED })).toEqual([]);
      await expect(namedAddress()).resolves.toEqual({ kind: "unavailable" });

      await expect(
        createDrizzleDocumentAddressStore(db).candidate({
          projectId: PROJECT_ID as never,
          userId: USER_ID,
          scheme: "scratch",
          workId: NO_WORK,
          path: "/notes.md",
        }),
      ).resolves.toMatchObject({ kind: "current", documentId: FILE });
    });
  });
}
