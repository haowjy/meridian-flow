/** Drizzle ContextTreeMutationStore recursive-delete ownership and rollback proofs. */
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextAvailabilityHeads,
  contextCatalogCommits,
  contextCatalogEntries,
  contextCatalogScopeHeads,
  contextSources,
  documents,
  folders,
  projects,
  users,
} from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInDrizzleTransaction } from "../../../../shared/drizzle-transaction.js";
import { truncateDrizzleTables } from "../../../../test-support/drizzle-reset.js";
import { useRollbackTestDatabase } from "../../../../test-support/rollback-test-database.js";
import { createInMemoryEventSink } from "../../../observability/index.js";
import { createDrizzleContextCatalog } from "../context-catalog.js";
import { createDrizzleProjectContextAvailability } from "../project-context-availability.js";
import { DrizzleContextTreeMutationStore } from "./drizzle-tree-mutation-store.js";
import type { ContextDocumentMembershipObserver } from "./membership-event-dispatcher.js";

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
    const DOC_CALLBACK_FAILURE_ID = "00000000-0000-4000-8000-000000000714";
    const DOC_STALE_DELETE_ID = "00000000-0000-4000-8000-000000000715";
    const DOC_ROLLBACK_DELETE_ID = "00000000-0000-4000-8000-000000000716";

    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => truncateDrizzleTables(db, [users]),
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
        markdownProjection: name,
      });
    }

    it("deletes empty and populated folders with exact content identities", async () => {
      const nestedFolderId = "00000000-0000-4000-8000-000000000731";
      const binaryId = "00000000-0000-4000-8000-000000000732";
      const customId = "00000000-0000-4000-8000-000000000733";
      const nestedId = "00000000-0000-4000-8000-000000000734";
      const manifestId = "00000000-0000-4000-8000-000000000735";
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
        {
          id: manifestId,
          kind: "manifest",
          contextSourceId: SOURCE_ID,
          folderId: nestedFolderId,
          name: ".manifest",
          extension: "json",
          fileType: "json",
        },
      ]);
      const availability = createDrizzleProjectContextAvailability(db);
      const catalog = createDrizzleContextCatalog(db, undefined, {
        availabilityMutations: availability,
      });
      await catalog.refreshSources([SOURCE_ID]);
      const tree = new DrizzleContextTreeMutationStore(db, undefined, catalog);
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
      expect(tombstones).toHaveLength(5);
      expect(new Set(tombstones.map((row) => row.deletedAt?.toISOString()))).toHaveLength(1);
    });

    it("returns no receipt when delete CAS becomes stale or the transaction rolls back", async () => {
      await insertDocument(DOC_STALE_DELETE_ID, "stale-delete");
      await insertDocument(DOC_ROLLBACK_DELETE_ID, "rollback-delete");
      const tree = new DrizzleContextTreeMutationStore(
        db,
        undefined,
        createDrizzleContextCatalog(db),
      );
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
      "after-subtree-mutation",
      "after-catalog-refresh",
    ] as const)("rolls back every recursive-delete effect when failure is injected %s", async (failurePoint) => {
      const folderId =
        failurePoint === "after-subtree-mutation"
          ? "00000000-0000-4000-8000-000000000740"
          : "00000000-0000-4000-8000-000000000741";
      const documentId =
        failurePoint === "after-subtree-mutation"
          ? "00000000-0000-4000-8000-000000000742"
          : "00000000-0000-4000-8000-000000000743";
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
      const callbacks: string[] = [];
      const failingCatalog = {
        refreshProject: (projectId: string) => catalog.refreshProject(projectId),
        async refreshSources(sourceIds: readonly string[], invalidatedRootIds?: readonly string[]) {
          if (failurePoint === "after-subtree-mutation") {
            const [mutated] = await db
              .select({ deletedAt: documents.deletedAt })
              .from(documents)
              .where(eq(documents.id, documentId));
            expect(mutated?.deletedAt).toBeInstanceOf(Date);
            throw failure;
          }
          await catalog.refreshSources(sourceIds, invalidatedRootIds);
          throw failure;
        },
      };
      const tree = new DrizzleContextTreeMutationStore(
        db,
        {
          documentCreated: () => undefined,
          documentDeleted: (id) => {
            callbacks.push(id);
          },
        },
        failingCatalog,
      );
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
      expect(callbacks).toEqual([]);
      expect(publish).not.toHaveBeenCalled();
    });

    it("keeps the committed receipt when post-commit membership delivery fails", async () => {
      const callbackFolderId = "00000000-0000-4000-8000-000000000736";
      const successfulCallbackId = "00000000-0000-4000-8000-000000000737";
      await db.insert(folders).values({
        id: callbackFolderId,
        contextSourceId: SOURCE_ID,
        name: "callback-folder",
      });
      await db.insert(documents).values([
        {
          id: DOC_CALLBACK_FAILURE_ID,
          contextSourceId: SOURCE_ID,
          folderId: callbackFolderId,
          name: "callback-failure",
        },
        {
          id: successfulCallbackId,
          contextSourceId: SOURCE_ID,
          folderId: callbackFolderId,
          name: "callback-success",
        },
      ]);
      const callbackFailure = new Error("membership delivery failed");
      const evidence = createInMemoryEventSink();
      const callbacks: string[] = [];
      const tree = new DrizzleContextTreeMutationStore(
        db,
        {
          documentCreated: () => undefined,
          documentDeleted: (documentId) => {
            callbacks.push(documentId);
            if (documentId === DOC_CALLBACK_FAILURE_ID) throw callbackFailure;
          },
        },
        createDrizzleContextCatalog(db),
        evidence,
      );
      const token = await tree.inspect(SOURCE_ID, "callback-folder");
      if (!token) throw new Error("expected file token");

      const receipt = await tree.commitRecursiveDelete({ root: token, mode: "recursive" });
      expect(receipt).toMatchObject({
        ok: true,
        value: { deletedDocumentIds: [DOC_CALLBACK_FAILURE_ID, successfulCallbackId].sort() },
      });
      expect(callbacks).toEqual([DOC_CALLBACK_FAILURE_ID, successfulCallbackId].sort());
      const committed = await db
        .select({ deletedAt: documents.deletedAt })
        .from(documents)
        .where(eq(documents.folderId, callbackFolderId));
      expect(committed.every((row) => row.deletedAt instanceof Date)).toBe(true);
      expect(evidence.events).toHaveLength(1);
      expect(evidence.events[0]).toMatchObject({
        name: "PostCommitCallbackFailure",
        payload: {
          callbackKind: "documentDeleted",
          documentId: DOC_CALLBACK_FAILURE_ID,
          commandId: expect.any(String),
        },
      });
    });

    it("joins the ambient command transaction and dispatches observers only after its commit", async () => {
      await insertDocument(DOC_AMBIENT_DELETE_ID, "ambient-delete");
      const events: string[] = [];
      const observer: ContextDocumentMembershipObserver = {
        documentCreated: () => undefined,
        documentDeleted: () => {
          events.push("deleted");
        },
      };
      const tree = new DrizzleContextTreeMutationStore(
        db,
        observer,
        createDrizzleContextCatalog(db),
      );
      const token = await tree.inspect(SOURCE_ID, "ambient-delete.md");
      expect(token?.kind).toBe("file");

      await expect(
        runInDrizzleTransaction(db, async () => {
          await expect(
            tree.commitRecursiveDelete({
              root: token as NonNullable<typeof token>,
              mode: "recursive",
            }),
          ).resolves.toMatchObject({
            ok: true,
            value: {
              deletedDocumentIds: [DOC_AMBIENT_DELETE_ID],
              availabilityGeneration: expect.not.stringMatching(/^0$/),
            },
          });
          expect(events).toEqual([]);
          throw new Error("outer rollback");
        }),
      ).rejects.toThrow("outer rollback");
      expect(events).toEqual([]);
      const [rolledBack] = await db
        .select({ deletedAt: documents.deletedAt })
        .from(documents)
        .where(eq(documents.id, DOC_AMBIENT_DELETE_ID));
      expect(rolledBack?.deletedAt).toBeNull();

      const retryToken = await tree.inspect(SOURCE_ID, "ambient-delete.md");
      await runInDrizzleTransaction(db, async () => {
        await expect(
          tree.commitRecursiveDelete({
            root: retryToken as NonNullable<typeof retryToken>,
            mode: "recursive",
          }),
        ).resolves.toMatchObject({
          ok: true,
          value: {
            deletedDocumentIds: [DOC_AMBIENT_DELETE_ID],
            availabilityGeneration: expect.not.stringMatching(/^0$/),
          },
        });
        expect(events).toEqual([]);
      });
      expect(events).toEqual(["deleted"]);
    });
  });
}
