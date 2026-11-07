/**
 * Postgres-backed coverage for promoting work-scoped scratch documents.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - receipt lifetime, root representation, lineage-move policy, and provisional-name graduation
 */

import type { ContextDestinationParent } from "@meridian/contracts/protocol";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDocumentLinkScopes,
  testLinkDeps,
} from "../../domains/collab/test-support/document-link-scopes.js";
import { createDrizzleContextCatalog } from "../../domains/context/adapters/context-catalog.js";
import { moveCommand, parseUnifiedContextUri } from "../../domains/context/index.js";
import { createAllowAllFileAccess } from "../../domains/file-policy/index.js";
import {
  createProjectBootstrapRepositoryForTest as createDrizzleProjectBootstrapRepository,
  createProjectRepositoryForTest,
} from "../../domains/projects/test-support/project-repository.js";
import {
  createTestDocumentRemoval,
  createTestRemovalDeps,
} from "../../test-support/document-removal.js";
import { deleteAt, entryAt, moveTo } from "../../test-support/entry-ref.js";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";
import { contextErrorToHttp } from "../context-error-http.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("context move route (postgres)", () => {});
} else {
  describe("context move route (postgres)", async () => {
    const { Hocuspocus } = await import("@hocuspocus/server");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createCollabDomain } = await import("../../domains/collab/composition.js");
    const { createProductionUnifiedContextPortFactory } = await import(
      "../../domains/context/unified-context-port-factory.js"
    );
    const { createDrizzleProjectWorkAuthorityResolver } = await import(
      "../../domains/projects/index.js"
    );
    const { useRollbackTestDatabase, deleteDrizzleRows } = await import(
      "../../test-support/drizzle-reset.js"
    );
    const { createUntitledContextDocument } = await import(
      "../../routes/api/projects/[projectId]/context/[scheme]/create-untitled.post.js"
    );
    const { handleContextMoveRequest } = await import("../context-move-route.js");
    const { createDrizzleProjectContextAvailability } = await import(
      "../../domains/context/index.js"
    );
    const { locatorUri } = await import("../context-locator.js");
    const { isWorkScopedScheme } = await import("@meridian/contracts/context-uri");
    /**
     * A move written the way these cases state it (source and destination by path and owner),
     * committed through the port with the source's id, as the route does after locating the row.
     */
    const moveContextEntry = async (input: {
      port: import("../../domains/context/index.js").ContextPort;
      userId: string;
      sourceScheme: string;
      body: Record<string, unknown>;
    }) => {
      const body = { operationId: crypto.randomUUID(), ...input.body } as Record<string, any>;
      const resolver = createDrizzleProjectWorkAuthorityResolver(db);
      const resolve = async (
        scheme: string,
        path: string,
        workId: string | undefined,
        rootThreadId: string | undefined,
      ) => {
        if (rootThreadId) {
          const [root] = await db
            .select()
            .from(schema.threads)
            .where(eq(schema.threads.id, rootThreadId));
          if (!root?.ref) throw new Error("missing lineage root");
          return {
            scope: "lineage" as const,
            scheme: "scratch" as const,
            path,
            rootThreadId,
            authority: { kind: "lineage" as const, rootThreadRef: root.ref },
          };
        }
        if (!isWorkScopedScheme(scheme as never))
          return { scope: "project" as const, scheme: scheme as never, path };
        const [work] = workId
          ? await db
              .select({ projectId: schema.works.projectId })
              .from(schema.works)
              .where(eq(schema.works.id, workId))
          : await db
              .select({ projectId: schema.works.projectId })
              .from(schema.works)
              .where(eq(schema.works.isNoWork, true))
              .limit(1);
        if (!work) throw new Error("missing Work for move test");
        const authority = workId
          ? await resolver.byId(work.projectId, workId)
          : await resolver.noWork(work.projectId);
        if (!authority) throw new Error("missing Work authority for move test");
        return { scope: "work" as const, scheme: scheme as never, path, authority };
      };
      const source = await resolve(
        input.sourceScheme,
        body.path,
        body.sourceWorkId,
        body.sourceRootThreadId,
      );
      const destination = await resolve(
        body.destinationScheme,
        body.destinationFolderPath ?? "",
        body.destinationWorkId,
        body.destinationRootThreadId,
      );
      const parent = body.destinationParent as ContextDestinationParent | undefined;
      const result = await input.port.commitWriterLocation(body.expected, locatorUri(source, ""), {
        origin: { type: "human", userId: input.userId },
        destination:
          parent?.kind === "folder"
            ? {
                kind: "folder",
                folderId: parent.folderId,
                createFolders: parent.createFolders,
                authorize: body.authorizeDestination ?? (async () => true),
              }
            : {
                kind: "at",
                folderUri: locatorUri(destination, parent ? "" : destination.path),
                createFolders: parent?.createFolders,
              },
        position: body.position,
        ...(body.name ? { name: body.name } : {}),
        operation: {
          id: body.operationId,
          command: moveCommand({
            expected: body.expected,
            destinationParent: parent,
            position: body.position,
            name: body.name,
          }),
        },
      });
      if (!result.ok) contextErrorToHttp(result.error);
      const destinationUri = parseUnifiedContextUri(result.value.destinationUri);
      if (!destinationUri.ok) throw new Error("move answered an invalid address");
      return {
        status: "moved" as const,
        ...(result.value.linkUpdate ? { linkUpdate: result.value.linkUpdate } : {}),
        scheme: destinationUri.value.scheme,
        path: destinationUri.value.path,
        name: destinationUri.value.path.split("/").at(-1),
      };
    };

    const USER_ID = "00000000-0000-4000-8000-000000000941";
    const DOCUMENT_ID = "00000000-0000-4000-8000-000000000942";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => deleteDrizzleRows(db, [schema.users]),
    });
    let db = database.current;

    beforeEach(async () => {
      db = database.current;
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "scratch-promotion"));
    });

    const collabs: Array<{ dispose(): Promise<void> }> = [];
    afterEach(async () => {
      for (const collab of collabs.splice(0)) await collab.dispose();
    });

    function createBoundCollab() {
      const collab = createCollabDomain({
        ...testLinkDeps(db),
        fileAccess: createAllowAllFileAccess(),
        db,
        ...createTestRemovalDeps(db),
        workProjectionMutation: createTestWorkProjectionMutation(db),
        catalogMutations: createDrizzleContextCatalog(db),
      });
      collab.bindHocuspocus(
        new Hocuspocus({
          yDocOptions: { gc: false, gcFilter: () => true },
          onStoreDocument: ({ documentName, document }) =>
            collab.storeHocuspocusDocument(documentName, document),
        }),
      );
      collabs.push(collab);
      return collab;
    }

    async function yjsState(documentId: string) {
      const drafts = await db
        .select({ id: schema.documentDrafts.id })
        .from(schema.documentDrafts)
        .where(eq(schema.documentDrafts.documentId, documentId));
      const draftIds = new Set(drafts.map((documentDraft) => documentDraft.id));
      return {
        checkpoints: await db
          .select()
          .from(schema.documentYjsCheckpoints)
          .where(eq(schema.documentYjsCheckpoints.documentId, documentId)),
        heads: await db
          .select()
          .from(schema.documentYjsHeads)
          .where(eq(schema.documentYjsHeads.documentId, documentId)),
        updates: await db
          .select()
          .from(schema.documentYjsUpdates)
          .where(eq(schema.documentYjsUpdates.documentId, documentId)),
        journal: (await db.select().from(schema.draftWriteJournal)).filter((row) =>
          draftIds.has(row.draftId),
        ),
      };
    }

    async function arrangeUntitled() {
      const collab = createBoundCollab();
      const { projectId } = await createDrizzleProjectBootstrapRepository({
        db,
        documents: collab,
      }).ensureDefaultBootstrap(USER_ID as never);
      const workId = crypto.randomUUID();
      await db.insert(schema.works).values({
        id: workId,
        projectId,
        createdByUserId: USER_ID,
        name: "Current Work",
        handle: "w1",
      });
      const contextPorts = createProductionUnifiedContextPortFactory({
        pendingBranch: createTestWorkProjectionMutation(db),
        links: createTestDocumentLinkScopes(db),
        db,
        removal: createTestDocumentRemoval(db),
        documentSync: collab,
        branches: collab.branches,
      });
      const authority = await createDrizzleProjectWorkAuthorityResolver(db).byId(projectId, workId);
      if (!authority) throw new Error("missing Work authority");
      const port = contextPorts.forWork(
        authority,
        projectId,
        USER_ID,
        authority.workHandle ? new Map([[authority.workHandle, authority]]) : new Map(),
      );
      await createUntitledContextDocument({
        port,
        userId: USER_ID,
        scheme: "scratch",
        workId,
        body: { documentId: DOCUMENT_ID },
      });
      const mkdir = await port.mkdir("manuscript://Act 1", {
        origin: { type: "human", userId: USER_ID },
      });
      expect(mkdir).toEqual({ ok: true, value: undefined });
      return { projectId, workId, collab, port, contextPorts };
    }

    async function promotedRow(projectId: string) {
      const [row] = await db
        .select({
          id: schema.documents.id,
          sourceId: schema.documents.contextSourceId,
          sourceSlug: schema.contextSources.slug,
          sourceScope: schema.contextSources.scope,
          sourceWorkId: schema.contextSources.workId,
          folderName: schema.folders.name,
          folderSourceId: schema.folders.contextSourceId,
          name: schema.documents.name,
          extension: schema.documents.extension,
          provisionalName: schema.documents.provisionalName,
        })
        .from(schema.documents)
        .innerJoin(
          schema.contextSources,
          eq(schema.documents.contextSourceId, schema.contextSources.id),
        )
        .leftJoin(schema.folders, eq(schema.documents.folderId, schema.folders.id))
        .where(
          and(eq(schema.documents.id, DOCUMENT_ID), eq(schema.contextSources.projectId, projectId)),
        );
      return row;
    }

    async function sourceFolderId(workId: string) {
      const [row] = await db
        .select({ id: schema.folders.id })
        .from(schema.folders)
        .innerJoin(
          schema.contextSources,
          eq(schema.contextSources.id, schema.folders.contextSourceId),
        )
        .where(and(eq(schema.contextSources.workId, workId), eq(schema.folders.name, "Source")));
      if (!row) throw new Error("fixture folder missing");
      return row.id;
    }

    async function documentOwner(documentId: string) {
      const [row] = await db
        .select({
          documentId: schema.documents.id,
          documentSourceId: schema.documents.contextSourceId,
          sourceScope: schema.contextSources.scope,
          sourceWorkId: schema.contextSources.workId,
          sourceProjectId: schema.contextSources.projectId,
          folderName: schema.folders.name,
          folderSourceId: schema.folders.contextSourceId,
          documentName: schema.documents.name,
          extension: schema.documents.extension,
        })
        .from(schema.documents)
        .innerJoin(
          schema.contextSources,
          eq(schema.documents.contextSourceId, schema.contextSources.id),
        )
        .leftJoin(schema.folders, eq(schema.documents.folderId, schema.folders.id))
        .where(eq(schema.documents.id, documentId));
      return row;
    }

    it("replays the immutable move result before obsolete-source inspection and rejects ID reuse", async () => {
      const { port } = await arrangeUntitled();
      const operationId = crypto.randomUUID();
      const options = { operationId, expected: { kind: "file" as const, nodeId: DOCUMENT_ID } };
      const source = "scratch://@w1/Untitled 1";
      const first = await moveTo(port, source, "manuscript://first", options);
      expect(first.ok).toBe(true);
      await expect(
        moveTo(port, "manuscript://first", "manuscript://second", {
          operationId: crypto.randomUUID(),
          expected: options.expected,
        }),
      ).resolves.toMatchObject({ ok: true });
      const commits = await db.select().from(schema.contextCatalogCommits);
      await expect(moveTo(port, source, "manuscript://first", options)).resolves.toEqual(first);
      await expect(port.lookupOperation(operationId)).resolves.toMatchObject({
        operationId,
        result: first,
      });
      expect(await db.select().from(schema.contextCatalogCommits)).toEqual(commits);
      await expect(moveTo(port, source, "manuscript://other", options)).resolves.toMatchObject({
        ok: false,
        error: { code: "operation_mismatch" },
      });
      await expect(port.stat("manuscript://second")).resolves.toMatchObject({
        ok: true,
        value: { documentId: DOCUMENT_ID },
      });
    });

    it.each([
      "project",
      "account",
    ] as const)("retains receipts on soft deletion and cascades hard %s deletion", async (owner) => {
      const userId = crypto.randomUUID();
      const projectId = crypto.randomUUID();
      const operationId = crypto.randomUUID();
      await db.insert(schema.users).values(conformanceUserValues(userId, `receipt-${owner}`));
      await db
        .insert(schema.projects)
        .values({ id: projectId, userId, name: "Receipt retention", slug: "receipt-retention" });
      await db.insert(schema.contextOperationReceipts).values({
        userId,
        projectId,
        operationId,
        receipt: {
          observationVersion: "1",
          operationId,
          command: {
            kind: "delete",
            expected: { kind: "folder", nodeId: crypto.randomUUID() },
          },
          result: { ok: false, error: { code: "not_found", uri: "manuscript://missing" } },
        },
      });
      const readReceipt = () =>
        db
          .select()
          .from(schema.contextOperationReceipts)
          .where(eq(schema.contextOperationReceipts.operationId, operationId));
      await db
        .update(schema.projects)
        .set({ deletedAt: new Date() })
        .where(eq(schema.projects.id, projectId));
      expect(await readReceipt()).toHaveLength(1);
      if (owner === "project")
        await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
      else await db.delete(schema.users).where(eq(schema.users.id, userId));
      expect(await readReceipt()).toEqual([]);
    });

    it("keeps a delete receipt when its old path is claimed by a different document", async () => {
      const { projectId, port } = await arrangeUntitled();
      const uri = "scratch://@w1/Untitled 1";
      const operationId = crypto.randomUUID();
      const options = { operationId, expected: { kind: "file" as const, nodeId: DOCUMENT_ID } };
      const deleted = await deleteAt(port, uri, options);
      expect(deleted).toMatchObject({
        ok: true,
        value: { removed: [{ documentId: DOCUMENT_ID }] },
      });
      const replacement = await port.createTrackedDocument(uri, "replacement writing");
      expect(replacement.ok).toBe(true);
      await expect(deleteAt(port, uri, options)).resolves.toEqual(deleted);
      await expect(port.read(uri)).resolves.toMatchObject({
        ok: true,
        value: { content: "replacement writing\n" },
      });
      const { createDrizzleContextOperationReceipts } = await import(
        "../../domains/context/adapters/context-operation-receipts.js"
      );
      await expect(
        createDrizzleContextOperationReceipts(db, {
          projectId,
          userId: crypto.randomUUID(),
        }).lookup(operationId),
      ).resolves.toBeNull();
      await expect(
        createDrizzleContextOperationReceipts(db, {
          projectId: crypto.randomUUID(),
          userId: USER_ID,
        }).lookup(operationId),
      ).resolves.toBeNull();
    });

    it("rolls back failed namespace/catalog work before saving rejection, but never saves infrastructure failure", async () => {
      const { projectId, port } = await arrangeUntitled();
      const { ContextOperationReceipts } = await import(
        "../../domains/context/context/context-operation-receipts.js"
      );
      const { createDrizzleContextOperationReceipts } = await import(
        "../../domains/context/adapters/context-operation-receipts.js"
      );
      const receipts = new ContextOperationReceipts(
        createDrizzleContextOperationReceipts(db, { projectId, userId: USER_ID }),
      );
      const command = {
        kind: "move" as const,
        expected: { kind: "file" as const, nodeId: DOCUMENT_ID },
      };
      for (const code of ["conflict", "io_error"] as const) {
        const operationId = crypto.randomUUID();
        const before = await db.select().from(schema.contextCatalogCommits);
        const result = await receipts.execute(
          operationId,
          command,
          "manuscript://source",
          async () => {
            await port.mkdir("manuscript://rolled-back");
            return {
              ok: false,
              error: { code, uri: "manuscript://rolled-back/new", message: "injected failure" },
            };
          },
        );
        expect(result.ok).toBe(false);
        await expect(port.stat("manuscript://rolled-back")).resolves.toMatchObject({ ok: false });
        expect(await db.select().from(schema.contextCatalogCommits)).toEqual(before);
        const receipt = await receipts.lookup(operationId);
        if (code === "conflict") expect(receipt).toMatchObject({ result });
        else expect(receipt).toBeNull();
      }
    });

    it("does not record a thrown infrastructure failure and rolls its namespace work back", async () => {
      const { projectId, port } = await arrangeUntitled();
      const { ContextOperationReceipts } = await import(
        "../../domains/context/context/context-operation-receipts.js"
      );
      const { createDrizzleContextOperationReceipts } = await import(
        "../../domains/context/adapters/context-operation-receipts.js"
      );
      const receipts = new ContextOperationReceipts(
        createDrizzleContextOperationReceipts(db, { projectId, userId: USER_ID }),
      );
      const operationId = crypto.randomUUID();
      const failure = new Error("injected infrastructure failure");
      const before = await db.select().from(schema.contextCatalogCommits);
      await expect(
        receipts.execute(
          operationId,
          {
            kind: "delete",
            expected: { kind: "folder", nodeId: crypto.randomUUID() },
          },
          "manuscript://rolled-back",
          async () => {
            await port.mkdir("manuscript://rolled-back");
            throw failure;
          },
        ),
      ).rejects.toBe(failure);
      await expect(receipts.lookup(operationId)).resolves.toBeNull();
      await expect(port.stat("manuscript://rolled-back")).resolves.toMatchObject({ ok: false });
      expect(await db.select().from(schema.contextCatalogCommits)).toEqual(before);
    });

    it("revokes archived Work mutations without losing its management identity", async () => {
      const { projectId, workId, port } = await arrangeUntitled();
      await db
        .update(schema.works)
        .set({ archivedAt: new Date() })
        .where(eq(schema.works.id, workId));
      await expect(
        port.createTrackedDocument("scratch://@w1/new", "blocked"),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "context_unavailable" },
      });
      await expect(
        moveTo(port, "scratch://@w1/Untitled 1", "manuscript://moved", {
          expected: { kind: "file", nodeId: DOCUMENT_ID },
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: "context_unavailable" } });
      const authority = createDrizzleProjectWorkAuthorityResolver(db);
      await expect(authority.byId(projectId, workId)).resolves.toMatchObject({ workId });
      expect((await documentOwner(DOCUMENT_ID)).sourceWorkId).toBe(workId);
      await db.update(schema.works).set({ archivedAt: null }).where(eq(schema.works.id, workId));
      await expect(
        moveTo(port, "scratch://@w1/Untitled 1", "manuscript://moved", {
          expected: { kind: "file", nodeId: DOCUMENT_ID },
        }),
      ).resolves.toMatchObject({ ok: true });
    });

    async function destinationFolder(projectId: string) {
      const [parent] = await db
        .select({ id: schema.folders.id })
        .from(schema.folders)
        .innerJoin(
          schema.contextSources,
          eq(schema.folders.contextSourceId, schema.contextSources.id),
        )
        .where(
          and(eq(schema.contextSources.projectId, projectId), eq(schema.folders.name, "Act 1")),
        );
      if (!parent) throw new Error("Missing fixture parent");
      return parent.id;
    }

    it("follows a captured parent into its current scheme and records its identity", async () => {
      const { projectId, workId, port } = await arrangeUntitled();
      const folderId = await destinationFolder(projectId);
      const operationId = crypto.randomUUID();
      await expect(
        moveTo(port, "manuscript://Act 1", "kb://Renamed", {
          expected: { kind: "folder", nodeId: folderId },
          operationId: crypto.randomUUID(),
        }),
      ).resolves.toMatchObject({ ok: true });
      const body = {
        operationId,
        path: "Untitled 1",
        sourceWorkId: workId,
        expected: { kind: "file", nodeId: DOCUMENT_ID },
        destinationScheme: "manuscript",
        destinationFolderPath: "Act 1",
        destinationParent: { kind: "folder", folderId },
      };
      await expect(
        moveContextEntry({ port, userId: USER_ID, sourceScheme: "scratch", body }),
      ).resolves.toMatchObject({ status: "moved", scheme: "kb", path: "Renamed/Untitled 1" });
      await expect(port.lookupOperation(operationId)).resolves.toMatchObject({
        command: { expected: body.expected, destinationParent: body.destinationParent },
        result: { ok: true, value: { destinationUri: "kb://Renamed/Untitled 1" } },
      });
      await expect(port.stat("manuscript://Act 1")).resolves.toMatchObject({ ok: false });
      await expect(port.stat("kb://Renamed/Untitled 1")).resolves.toMatchObject({ ok: true });
      await expect(
        moveTo(port, "scratch://@w1/Untitled 1", "manuscript://Act 1/Untitled 1", {
          operationId,
          expected: { kind: "file", nodeId: DOCUMENT_ID },
          destinationParent: { kind: "folder", folderId: crypto.randomUUID() },
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: "operation_mismatch" } });
    });

    it("lands beside an occupied name at the renamed identity", async () => {
      const { projectId, workId, port } = await arrangeUntitled();
      const folderId = await destinationFolder(projectId);
      await moveTo(port, "manuscript://Act 1", "manuscript://Renamed", {
        expected: { kind: "folder", nodeId: folderId },
        operationId: crypto.randomUUID(),
      });
      await port.createTrackedDocument("manuscript://Renamed/Untitled 1", "Occupied");
      await expect(
        moveContextEntry({
          port,
          userId: USER_ID,
          sourceScheme: "scratch",
          body: {
            path: "Untitled 1",
            sourceWorkId: workId,
            expected: { kind: "file", nodeId: DOCUMENT_ID },
            destinationScheme: "manuscript",
            destinationFolderPath: "Act 1",
            destinationParent: { kind: "folder", folderId },
          },
        }),
      ).resolves.toMatchObject({
        status: "moved",
        scheme: "manuscript",
        path: "Renamed/Untitled 1 (2)",
      });
      await expect(port.stat("manuscript://Act 1")).resolves.toMatchObject({ ok: false });
    });

    it("records a typed refusal when the resolved destination fails its edit check", async () => {
      const { projectId, port } = await arrangeUntitled();
      const folderId = await destinationFolder(projectId);
      const operationId = crypto.randomUUID();
      await expect(
        moveTo(port, "scratch://@w1/Untitled 1", "manuscript://Act 1/Untitled 1", {
          operationId,
          expected: { kind: "file", nodeId: DOCUMENT_ID },
          destinationParent: { kind: "folder", folderId },
          authorize: async () => false,
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: "permission_denied" } });
      await expect(port.lookupOperation(operationId)).resolves.toMatchObject({
        result: { ok: false, error: { code: "permission_denied" } },
      });
      await expect(port.stat("scratch://@w1/Untitled 1")).resolves.toMatchObject({
        ok: true,
      });
    });

    it("refuses a folder identity outside the actor's project authority", async () => {
      const { port } = await arrangeUntitled();
      const otherUserId = crypto.randomUUID();
      const otherProjectId = crypto.randomUUID();
      const otherSourceId = crypto.randomUUID();
      const folderId = crypto.randomUUID();
      await db
        .insert(schema.users)
        .values(conformanceUserValues(otherUserId, "inaccessible-folder"));
      await db.insert(schema.projects).values({
        id: otherProjectId,
        userId: otherUserId,
        name: "Private",
        slug: "private",
      });
      await db.insert(schema.contextSources).values({
        id: otherSourceId,
        projectId: otherProjectId,
        slug: "manuscript",
        name: "Manuscript",
        scope: "project",
      });
      await db.insert(schema.folders).values({
        id: folderId,
        contextSourceId: otherSourceId,
        name: "Destination",
      });
      await expect(
        moveTo(port, "scratch://@w1/Untitled 1", "manuscript://Act 1/Untitled 1", {
          operationId: crypto.randomUUID(),
          expected: { kind: "file", nodeId: DOCUMENT_ID },
          destinationParent: { kind: "folder", folderId },
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: "destination_missing" } });
      await expect(port.stat("scratch://@w1/Untitled 1")).resolves.toMatchObject({
        ok: true,
      });
    });

    it("records an explicit area-root destination without manufacturing a parent", async () => {
      const { workId, port } = await arrangeUntitled();
      const operationId = crypto.randomUUID();
      const destinationParent = {
        kind: "root",
        scheme: "manuscript",
        owner: { workId: null },
      } as const;
      await expect(
        moveContextEntry({
          port,
          userId: USER_ID,
          sourceScheme: "scratch",
          body: {
            operationId,
            path: "Untitled 1",
            sourceWorkId: workId,
            expected: { kind: "file", nodeId: DOCUMENT_ID },
            destinationScheme: "manuscript",
            destinationFolderPath: "",
            destinationParent,
          },
        }),
      ).resolves.toMatchObject({ status: "moved", path: "Untitled 1" });
      await expect(port.lookupOperation(operationId)).resolves.toMatchObject({
        command: { destinationParent },
        result: { ok: true },
      });
      const [document] = await db
        .select({ folderId: schema.documents.folderId })
        .from(schema.documents)
        .where(eq(schema.documents.id, DOCUMENT_ID));
      expect(document?.folderId).toBeNull();
    });

    it("refuses a deleted destination identity without recreating its folder", async () => {
      const { projectId, port } = await arrangeUntitled();
      const [parent] = await db
        .select({ id: schema.folders.id })
        .from(schema.folders)
        .innerJoin(
          schema.contextSources,
          eq(schema.folders.contextSourceId, schema.contextSources.id),
        )
        .where(
          and(eq(schema.contextSources.projectId, projectId), eq(schema.folders.name, "Act 1")),
        );
      if (!parent) throw new Error("Missing fixture parent");
      const operationId = crypto.randomUUID();
      await deleteAt(port, "manuscript://Act 1", {
        expected: { kind: "folder", nodeId: parent.id },
        operationId: crypto.randomUUID(),
      });
      const options = {
        operationId,
        expected: { kind: "file" as const, nodeId: DOCUMENT_ID },
        destinationParent: { kind: "folder" as const, folderId: parent.id },
      };
      const result = await moveTo(
        port,
        "scratch://@w1/Untitled 1",
        "manuscript://Act 1/Untitled 1",
        options,
      );
      expect(result).toMatchObject({ ok: false, error: { code: "destination_missing" } });
      expect(await port.lookupOperation(operationId)).toMatchObject({
        command: { destinationParent: options.destinationParent },
        result,
      });
      await expect(
        moveTo(port, "scratch://@w1/Untitled 1", "manuscript://Act 1/Untitled 1", options),
      ).resolves.toEqual(result);
      await expect(port.stat("manuscript://Act 1")).resolves.toMatchObject({ ok: false });
      const [document] = await db
        .select()
        .from(schema.documents)
        .where(eq(schema.documents.id, DOCUMENT_ID));
      expect(document?.folderId).toBeNull();
      expect(document?.contextSourceId).not.toBe(parent.id);
    });

    it("follows a destination folder out of a Work retired after the request was prepared", async () => {
      const { projectId, workId, port, contextPorts } = await arrangeUntitled();
      await expect(port.mkdir("scratch://@w1/B")).resolves.toMatchObject({ ok: true });
      const [parent] = await db
        .select({ id: schema.folders.id })
        .from(schema.folders)
        .innerJoin(
          schema.contextSources,
          eq(schema.folders.contextSourceId, schema.contextSources.id),
        )
        .where(and(eq(schema.contextSources.workId, workId), eq(schema.folders.name, "B")));
      if (!parent) throw new Error("Missing parent");
      const folderId = parent.id;
      await expect(
        moveTo(port, "scratch://@w1/Untitled 1", "manuscript://loose", {
          expected: { kind: "file", nodeId: DOCUMENT_ID },
          operationId: crypto.randomUUID(),
        }),
      ).resolves.toMatchObject({ ok: true });
      const body = {
        operationId: crypto.randomUUID(),
        kind: "file",
        destinationParent: { kind: "folder", folderId },
      };
      await expect(
        moveTo(port, "scratch://@w1/B", "manuscript://Renamed", {
          expected: { kind: "folder", nodeId: folderId },
          operationId: crypto.randomUUID(),
        }),
      ).resolves.toMatchObject({ ok: true });
      await db
        .update(schema.works)
        .set({ deletedAt: new Date() })
        .where(eq(schema.works.id, workId));
      // The request names the destination folder and nothing about the Work it once sat in, so
      // the folder is followed to where it is now and the move lands.
      await expect(
        handleContextMoveRequest(
          {
            fileAccess: createAllowAllFileAccess(),
            projectRepo: createProjectRepositoryForTest({ db }),
            contextPorts,
            workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
            availability: createDrizzleProjectContextAvailability(db),
          },
          { projectId, userId: USER_ID, entryId: DOCUMENT_ID, body },
        ),
      ).resolves.toEqual({ status: "moved" });
      await expect(port.stat("manuscript://Renamed/loose")).resolves.toMatchObject({ ok: true });
    });
    it("creates missing suffix folders beneath an anchor renamed before delivery and replays exactly", async () => {
      const { projectId, workId, port } = await arrangeUntitled();
      const folderId = await destinationFolder(projectId);
      const body = {
        operationId: crypto.randomUUID(),
        path: "Untitled 1",
        sourceWorkId: workId,
        expected: { kind: "file", nodeId: DOCUMENT_ID },
        destinationScheme: "manuscript",
        destinationFolderPath: "Act 1/New Arc/Part 1",
        destinationParent: { kind: "folder", folderId, createFolders: ["New Arc", "Part 1"] },
        name: "Chapter 1",
      };
      await expect(
        moveTo(port, "manuscript://Act 1", "manuscript://Renamed", {
          expected: { kind: "folder", nodeId: folderId },
          operationId: crypto.randomUUID(),
        }),
      ).resolves.toMatchObject({ ok: true });
      const deliver = () =>
        moveContextEntry({ port, userId: USER_ID, sourceScheme: "scratch", body });
      const result = await deliver();
      expect(result).toMatchObject({
        status: "moved",
        path: "Renamed/New Arc/Part 1/Chapter 1",
      });
      await expect(
        port.stat("manuscript://Renamed/New Arc/Part 1/Chapter 1"),
      ).resolves.toMatchObject({ ok: true, value: { documentId: DOCUMENT_ID } });
      await expect(port.stat("manuscript://Act 1")).resolves.toMatchObject({ ok: false });
      await expect(port.lookupOperation(body.operationId)).resolves.toMatchObject({
        command: { destinationParent: body.destinationParent },
      });
      await expect(deliver()).resolves.toEqual(result);
      await expect(
        moveContextEntry({
          port,
          userId: USER_ID,
          sourceScheme: "scratch",
          body: {
            ...body,
            destinationParent: { ...body.destinationParent, createFolders: ["Different"] },
          },
        }),
      ).rejects.toMatchObject({
        status: 409,
        data: {
          __meridianInterruptEnvelope: {
            error: { code: "operation_mismatch", retryable: false },
          },
        },
      });
    });

    it("creates a missing link address beneath an area-root identity", async () => {
      const { workId, port } = await arrangeUntitled();
      await expect(
        moveContextEntry({
          port,
          userId: USER_ID,
          sourceScheme: "scratch",
          body: {
            path: "Untitled 1",
            sourceWorkId: workId,
            expected: { kind: "file", nodeId: DOCUMENT_ID },
            name: "Chapter 1",
            destinationScheme: "manuscript",
            destinationFolderPath: "New Arc/Part 1",
            destinationParent: {
              kind: "root",
              scheme: "manuscript",
              owner: { workId: null },
              createFolders: ["New Arc", "Part 1"],
            },
          },
        }),
      ).resolves.toMatchObject({ status: "moved", path: "New Arc/Part 1/Chapter 1" });
      await expect(port.stat("manuscript://New Arc/Part 1/Chapter 1")).resolves.toMatchObject({
        ok: true,
        value: { documentId: DOCUMENT_ID },
      });
    });
    it("refuses a deleted anchor without creating any suffix folders", async () => {
      const { projectId, workId, port } = await arrangeUntitled();
      const folderId = await destinationFolder(projectId);
      await expect(
        deleteAt(port, "manuscript://Act 1", {
          expected: { kind: "folder", nodeId: folderId },
          operationId: crypto.randomUUID(),
        }),
      ).resolves.toMatchObject({ ok: true });
      const before = await db.select().from(schema.folders);
      const operationId = crypto.randomUUID();
      await expect(
        moveContextEntry({
          port,
          userId: USER_ID,
          sourceScheme: "scratch",
          body: {
            operationId,
            path: "Untitled 1",
            sourceWorkId: workId,
            expected: { kind: "file", nodeId: DOCUMENT_ID },
            destinationScheme: "manuscript",
            destinationFolderPath: "Act 1/New Arc/Part 1",
            destinationParent: { kind: "folder", folderId, createFolders: ["New Arc", "Part 1"] },
          },
        }),
      ).rejects.toMatchObject({
        data: {
          __meridianInterruptEnvelope: { error: { code: "destination_missing" } },
        },
      });
      expect(await db.select().from(schema.folders)).toEqual(before);
      await expect(port.lookupOperation(operationId)).resolves.toMatchObject({
        command: {
          destinationParent: { kind: "folder", folderId, createFolders: ["New Arc", "Part 1"] },
        },
        result: { ok: false, error: { code: "destination_missing" } },
      });
      await expect(port.stat("scratch://@w1/Untitled 1")).resolves.toMatchObject({
        ok: true,
        value: { documentId: DOCUMENT_ID },
      });
    });
    it("promotes scratch into manuscript, graduating provisional naming without touching Yjs authority", async () => {
      const { projectId, workId, port } = await arrangeUntitled();
      const documentYjsBefore = await yjsState(DOCUMENT_ID);

      await expect(
        moveContextEntry({
          port,
          userId: USER_ID,
          sourceScheme: "scratch",
          body: {
            expected: { kind: "file", nodeId: DOCUMENT_ID },
            path: "Untitled 1",
            sourceWorkId: workId,
            destinationScheme: "manuscript",
            destinationFolderPath: "Act 1",
          },
        }),
      ).resolves.toEqual({
        status: "moved",
        linkUpdate: { links: 0, documents: 0 },
        scheme: "manuscript",
        path: "Act 1/Untitled 1",
        name: "Untitled 1",
      });

      const row = await promotedRow(projectId);
      expect(row).toMatchObject({
        id: DOCUMENT_ID,
        sourceSlug: "manuscript",
        sourceScope: "project",
        sourceWorkId: null,
        folderName: "Act 1",
        name: "Untitled 1",
        extension: "",
        // An explicit writer placement ends provisional state even when the
        // name stays Untitled-N (D8 total graduation).
        provisionalName: false,
      });
      expect(row?.sourceId).toBe(row?.folderSourceId);
      await expect(port.stat(`scratch://@w1/Untitled 1`)).resolves.toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
      await expect(port.stat("manuscript://Act 1/Untitled 1")).resolves.toMatchObject({
        ok: true,
        value: { documentId: DOCUMENT_ID },
      });

      expect(await yjsState(DOCUMENT_ID)).toEqual(documentYjsBefore);
    });

    it("refuses first write into a fully trashed lineage without provisioning notes", async () => {
      const { projectId, port } = await arrangeUntitled();
      const rootId = crypto.randomUUID();
      await db.insert(schema.threads).values({
        id: rootId,
        rootThreadId: rootId,
        ref: "c12",
        projectId,
        createdByUserId: USER_ID,
        deletedAt: new Date(),
      });
      const result = await port.write("scratch://@c12/after-trash", "unavailable", {
        origin: { type: "agent", agentSlug: null, threadId: rootId, turnId: crypto.randomUUID() },
      });
      expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(
        await db
          .select()
          .from(schema.contextSources)
          .where(eq(schema.contextSources.rootThreadId, rootId)),
      ).toEqual([]);
    });

    it("moves lineage notes to a Work but refuses writer moves back into a lineage", async () => {
      const { projectId, workId, port } = await arrangeUntitled();
      const rootId = crypto.randomUUID();
      await db.insert(schema.threads).values({
        id: rootId,
        rootThreadId: rootId,
        ref: "c12",
        projectId,
        createdByUserId: USER_ID,
      });
      const created = await port.createTrackedDocument("scratch://@c12/Unassigned", "portable", {
        origin: { type: "agent", agentSlug: null, threadId: rootId, turnId: crypto.randomUUID() },
      });
      expect(created).toMatchObject({
        ok: true,
        value: { uri: "scratch://@c12/Unassigned", documentId: expect.any(String) },
      });
      if (!created.ok || !created.value.documentId) throw new Error("missing no-Work document");
      const documentId = created.value.documentId;
      await expect(documentOwner(documentId)).resolves.toMatchObject({
        documentId,
        sourceScope: "lineage",
        sourceWorkId: null,
        sourceProjectId: projectId,
        folderName: null,
        documentName: "Unassigned",
        extension: "",
      });

      await expect(
        moveContextEntry({
          port,
          userId: USER_ID,
          sourceScheme: "scratch",
          body: {
            expected: { kind: "file", nodeId: documentId },
            path: "Unassigned",
            sourceRootThreadId: rootId,
            destinationScheme: "scratch",
            destinationWorkId: workId,
            destinationFolderPath: "Assigned",
          },
        }),
      ).resolves.toEqual({
        status: "moved",
        linkUpdate: { links: 0, documents: 0 },
        scheme: "scratch",
        path: "Assigned/Unassigned",
        name: "Unassigned",
      });
      const assigned = await documentOwner(documentId);
      expect(assigned).toMatchObject({
        documentId,
        sourceScope: "work",
        sourceWorkId: workId,
        sourceProjectId: null,
        folderName: "Assigned",
      });
      expect(assigned?.documentSourceId).toBe(assigned?.folderSourceId);
      await expect(port.stat("scratch://@w1/Assigned/Unassigned")).resolves.toMatchObject({
        ok: true,
        value: { documentId },
      });
      await expect(port.stat("scratch://@c12/Unassigned")).resolves.toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });

      await expect(
        moveContextEntry({
          port,
          userId: USER_ID,
          sourceScheme: "scratch",
          body: {
            expected: { kind: "file", nodeId: documentId },
            path: "Assigned/Unassigned",
            sourceWorkId: workId,
            destinationScheme: "scratch",
            destinationRootThreadId: rootId,
            destinationFolderPath: "Returned",
          },
        }),
      ).rejects.toThrow();
    });

    it("graduates provisional naming in place on a deliberate stay-put", async () => {
      const { workId, port } = await arrangeUntitled();
      const rowBefore = await db
        .select()
        .from(schema.documents)
        .where(eq(schema.documents.id, DOCUMENT_ID));
      const yjsBefore = await yjsState(DOCUMENT_ID);

      // Same scheme, same folder, same name: the writer's explicit
      // "keep it here" ends provisional naming with no tree mutation.
      await expect(
        moveContextEntry({
          port,
          userId: USER_ID,
          sourceScheme: "scratch",
          body: {
            expected: { kind: "file", nodeId: DOCUMENT_ID },
            path: "Untitled 1",
            sourceWorkId: workId,
            destinationScheme: "scratch",
            destinationWorkId: workId,
            destinationFolderPath: "",
          },
        }),
      ).resolves.toEqual({
        status: "moved",
        scheme: "scratch",
        path: "Untitled 1",
        name: "Untitled 1",
      });

      const rowAfter = await db
        .select()
        .from(schema.documents)
        .where(eq(schema.documents.id, DOCUMENT_ID));
      expect(rowAfter[0]).toEqual({ ...rowBefore[0], provisionalName: false });
      expect(await yjsState(DOCUMENT_ID)).toEqual(yjsBefore);
    });

    it("moves a folder and its children across schemes", async () => {
      const { workId, port } = await arrangeUntitled();
      await expect(
        port.mkdir(`scratch://@w1/Source/Nested`, {
          origin: { type: "human", userId: USER_ID },
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        port.createTrackedDocument(`scratch://@w1/Source/Nested/chapter`, "Chapter", {
          origin: { type: "human", userId: USER_ID },
        }),
      ).resolves.toMatchObject({ ok: true });

      await expect(
        moveContextEntry({
          port,
          userId: USER_ID,
          sourceScheme: "scratch",
          body: {
            expected: { kind: "folder", nodeId: await sourceFolderId(workId) },
            path: "Source",
            sourceWorkId: workId,
            destinationScheme: "manuscript",
            destinationFolderPath: "Act 1",
          },
        }),
      ).resolves.toEqual({
        status: "moved",
        linkUpdate: { links: 0, documents: 0 },
        scheme: "manuscript",
        path: "Act 1/Source",
        name: "Source",
      });
      await expect(port.stat("manuscript://Act 1/Source/Nested/chapter")).resolves.toMatchObject({
        ok: true,
      });
      await expect(port.stat(`scratch://@w1/Source/Nested/chapter`)).resolves.toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
    });

    it("lands an arriving folder beside the exact existing folder", async () => {
      const { workId, port } = await arrangeUntitled();
      await expect(port.mkdir(`scratch://@w1/Source/Children`)).resolves.toMatchObject({
        ok: true,
      });
      await expect(port.mkdir("manuscript://Act 1/Source")).resolves.toMatchObject({ ok: true });

      await expect(
        moveContextEntry({
          port,
          userId: USER_ID,
          sourceScheme: "scratch",
          body: {
            expected: { kind: "folder", nodeId: await sourceFolderId(workId) },
            path: "Source",
            sourceWorkId: workId,
            destinationScheme: "manuscript",
            destinationFolderPath: "Act 1",
          },
        }),
      ).resolves.toEqual({
        status: "moved",
        linkUpdate: { links: 0, documents: 0 },
        scheme: "manuscript",
        path: "Act 1/Source (2)",
        name: "Source (2)",
      });
      await expect(port.list("manuscript://Act 1/Source")).resolves.toEqual({
        ok: true,
        value: { uri: "manuscript://Act 1/Source", entries: [] },
      });
      await expect(port.list("manuscript://Act 1/Source (2)/Children")).resolves.toMatchObject({
        ok: true,
      });
    });

    it("writes nothing into holders and counts only incoming links that name the moved documents", async () => {
      const { projectId, port } = await arrangeUntitled();
      const write = async (uri: string) => {
        const written = await port.createTrackedDocument(uri, "Text.", {
          origin: { type: "human", userId: USER_ID },
        });
        if (!written.ok || !written.value.documentId) throw new Error(`write failed: ${uri}`);
        return written.value.documentId;
      };
      const target = await write("manuscript://Act 1/target");
      const unmoved = await write("manuscript://unmoved");
      const holder = await write("manuscript://holder");
      const aheadHolder = await write("manuscript://ahead-holder");
      const otherProject = crypto.randomUUID();
      const otherSource = crypto.randomUUID();
      const otherHolder = crypto.randomUUID();
      await db
        .insert(schema.projects)
        .values({ id: otherProject, userId: USER_ID, name: "Other", slug: "other-project" });
      await db.insert(schema.contextSources).values({
        id: otherSource,
        projectId: otherProject,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
      });
      await db
        .insert(schema.documents)
        .values({ id: otherHolder, contextSourceId: otherSource, name: "other", extension: "" });
      // A hidden draft holder is not live and contributes no incoming-link count.
      const nonLiveHolder = crypto.randomUUID();
      const [manuscript] = await db
        .select({ id: schema.contextSources.id })
        .from(schema.contextSources)
        .where(
          and(
            eq(schema.contextSources.projectId, projectId),
            eq(schema.contextSources.slug, "manuscript"),
          ),
        );
      if (!manuscript) throw new Error("fixture Manuscript missing");
      await db.insert(schema.documents).values({
        id: nonLiveHolder,
        contextSourceId: manuscript.id,
        name: "draft-only",
        extension: "",
        hidden: true,
      });
      const ahead = crypto.randomUUID();
      await db.insert(schema.linkAheadRefs).values({
        aheadId: ahead,
        projectId: projectId as never,
        scheme: "manuscript",
        path: "Act 1/target",
        settledDocumentId: target as never,
      });
      // Index rows as the certified derive writes them.
      const row = (sourceDocumentId: string, documentId: string, occurrences = 1) => ({
        sourceDocumentId: sourceDocumentId as never,
        linkKey: `doc:${documentId}`,
        targetDocumentId: documentId as never,
        address: "manuscript://x",
        occurrences,
      });
      await db.insert(schema.documentLinks).values([
        row(holder, target, 2),
        row(target, unmoved), // the moved document's own outgoing link
        row(otherHolder, target), // another project
        row(nonLiveHolder, target), // hidden
        {
          sourceDocumentId: aheadHolder as never,
          linkKey: `ahead:${ahead}`,
          aheadId: ahead,
          address: "manuscript://Act 1/target",
          occurrences: 1,
        },
      ]);
      const holderState = await yjsState(holder);
      const otherState = await yjsState(otherHolder);

      await expect(
        moveContextEntry({
          port,
          userId: USER_ID,
          sourceScheme: "manuscript",
          body: {
            expected: { kind: "file", nodeId: target },
            path: "Act 1/target",
            destinationScheme: "manuscript",
            destinationFolderPath: "",
            name: "renamed",
          },
        }),
      ).resolves.toMatchObject({ status: "moved", linkUpdate: { links: 3, documents: 2 } });
      expect(await yjsState(holder)).toEqual(holderState);
      expect(await yjsState(otherHolder)).toEqual(otherState);

      // A personal document moved into the project: only this project's holders count.
      const cast = await write("user://cast");
      await db.insert(schema.documentLinks).values([row(holder, cast), row(otherHolder, cast)]);
      await expect(
        moveTo(port, "user://cast", "kb://cast", {
          expected: await entryAt(port, "user://cast"),
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: { linkUpdate: { links: 1, documents: 1 } },
      });

      // Renumber two linked chapters in sequence: the first takes the address the second
      // vacated. Each move counts its own incoming link; the holder and its index stay put.
      // The project's first chapter already lives there: overwrite it.
      const overwritten = await port.write("manuscript://Chapter 1", "Text.", {
        origin: { type: "human", userId: USER_ID },
      });
      if (!overwritten.ok || !overwritten.value.documentId) throw new Error("overwrite failed");
      const chapterOne = overwritten.value.documentId;
      const chapterTwo = await write("manuscript://Chapter 2");
      await db
        .insert(schema.documentLinks)
        .values([row(holder, chapterOne), row(holder, chapterTwo, 2)]);
      const renumberState = await yjsState(holder);
      const holderLinks = () =>
        db
          .select({
            key: schema.documentLinks.linkKey,
            target: schema.documentLinks.targetDocumentId,
          })
          .from(schema.documentLinks)
          .where(eq(schema.documentLinks.sourceDocumentId, holder as never))
          .orderBy(schema.documentLinks.linkKey);
      const linksBefore = await holderLinks();
      await expect(
        moveTo(port, "manuscript://Chapter 2", "manuscript://Chapter 3", {
          expected: await entryAt(port, "manuscript://Chapter 2"),
        }),
      ).resolves.toMatchObject({ ok: true, value: { linkUpdate: { links: 2, documents: 1 } } });
      await expect(
        moveTo(port, "manuscript://Chapter 1", "manuscript://Chapter 2", {
          expected: await entryAt(port, "manuscript://Chapter 1"),
        }),
      ).resolves.toMatchObject({ ok: true, value: { linkUpdate: { links: 1, documents: 1 } } });
      await expect(port.stat("manuscript://Chapter 2")).resolves.toMatchObject({
        ok: true,
        value: { documentId: chapterOne },
      });
      await expect(port.stat("manuscript://Chapter 3")).resolves.toMatchObject({
        ok: true,
        value: { documentId: chapterTwo },
      });
      expect(await yjsState(holder)).toEqual(renumberState);
      expect(await holderLinks()).toEqual(linksBefore);
    });
  });
}
