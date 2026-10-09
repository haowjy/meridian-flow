/** Postgres-backed coverage for promoting work-scoped scratch documents. */

import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDrizzleDocumentAssetPaths } from "../../domains/context/adapters/asset-path-resolver.js";
import { createAllowAllFileAccess } from "../../domains/file-policy/index.js";
import { createProjectBootstrapRepositoryForTest as createDrizzleProjectBootstrapRepository } from "../../domains/projects/test-support/project-repository.js";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";

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
    const { commitContextMove, parseContextMove } = await import("../context-move-route.js");
    const moveContextEntry = async (input: {
      port: import("../../domains/context/index.js").ContextPort;
      userId: string;
      sourceScheme: string;
      body: unknown;
    }) => {
      const move = parseContextMove({
        sourceScheme: input.sourceScheme,
        body: { operationId: crypto.randomUUID(), ...(input.body as Record<string, unknown>) },
      });
      const resolver = createDrizzleProjectWorkAuthorityResolver(db);
      const resolveLocator = async (locator: typeof move.source) => {
        if (locator.scope === "project") return locator;
        const authority =
          locator.scope === "none"
            ? await resolver.noWork(
                (
                  await db
                    .select({ projectId: schema.works.projectId })
                    .from(schema.works)
                    .where(eq(schema.works.isNoWork, true))
                    .limit(1)
                )[0]?.projectId ?? "",
              )
            : await (async () => {
                const [work] = await db
                  .select({ projectId: schema.works.projectId })
                  .from(schema.works)
                  .where(eq(schema.works.id, locator.workId));
                if (!work) throw new Error("missing Work for move test");
                return resolver.byId(work.projectId, locator.workId);
              })();
        if (!authority) {
          throw new Error("missing Work authority for move test");
        }
        return { scope: "work" as const, scheme: locator.scheme, path: locator.path, authority };
      };
      return commitContextMove({
        port: input.port,
        userId: input.userId,
        move: {
          operationId: move.operationId,
          expected: move.expected,
          source: await resolveLocator(move.source),
          destination: await resolveLocator(move.destination),
          ...(move.name ? { name: move.name } : {}),
        },
      });
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

    const collabs: Array<{ dispose(): void }> = [];
    afterEach(() => {
      for (const collab of collabs.splice(0)) collab.dispose();
    });

    function createBoundCollab() {
      const collab = createCollabDomain({
        assetPaths: createDrizzleDocumentAssetPaths(db),
        fileAccess: createAllowAllFileAccess(),
        db,
        workProjectionMutation: createTestWorkProjectionMutation(db),
        workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
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
      const branches = await db
        .select({ id: schema.documentBranches.id })
        .from(schema.documentBranches)
        .where(eq(schema.documentBranches.documentId, documentId));
      const branchIds = new Set(branches.map((branch) => branch.id));
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
        journal: (await db.select().from(schema.branchWriteJournal)).filter((row) =>
          branchIds.has(row.branchId),
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
        slug: "current-work",
      });
      const contextPorts = createProductionUnifiedContextPortFactory({
        assetPaths: createDrizzleDocumentAssetPaths(db),
        db,
        documentSync: collab,
        manifestMembership: collab,
      });
      const authority = await createDrizzleProjectWorkAuthorityResolver(db).byId(projectId, workId);
      if (!authority) throw new Error("missing Work authority");
      const port = contextPorts.forWork(
        authority,
        projectId,
        USER_ID,
        authority.workSlug ? new Map([[authority.workSlug, authority]]) : new Map(),
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
      return { projectId, workId, collab, port };
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
      const source = "scratch://@current-work/Untitled 1.md";
      const first = await port.commitWriterLocation(source, "manuscript://first.md", options);
      expect(first.ok).toBe(true);
      await expect(
        port.commitWriterLocation("manuscript://first.md", "manuscript://second.md", {
          operationId: crypto.randomUUID(),
          expected: options.expected,
        }),
      ).resolves.toMatchObject({ ok: true });
      const commits = await db.select().from(schema.contextCatalogCommits);
      await expect(
        port.commitWriterLocation(source, "manuscript://first.md", options),
      ).resolves.toEqual(first);
      await expect(port.lookupOperation(operationId)).resolves.toMatchObject({
        operationId,
        result: first,
      });
      expect(await db.select().from(schema.contextCatalogCommits)).toEqual(commits);
      await expect(
        port.commitWriterLocation(source, "manuscript://other.md", options),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "operation_mismatch" },
      });
      await expect(port.stat("manuscript://second.md")).resolves.toMatchObject({
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
          operationId,
          command: { kind: "delete", uri: "manuscript://missing", expected: { kind: "folder" } },
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
      const uri = "scratch://@current-work/Untitled 1.md";
      const operationId = crypto.randomUUID();
      const options = { operationId, expected: { kind: "file" as const, documentId: DOCUMENT_ID } };
      const deleted = await port.delete(uri, options);
      expect(deleted).toMatchObject({ ok: true, value: { deletedDocumentIds: [DOCUMENT_ID] } });
      const replacement = await port.write(uri, "replacement writing");
      expect(replacement.ok).toBe(true);
      await expect(port.delete(uri, options)).resolves.toEqual(deleted);
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
        sourceUri: "manuscript://source.md",
        destinationUri: "manuscript://rolled-back/new.md",
        expected: { kind: "file" as const, nodeId: DOCUMENT_ID },
      };
      for (const code of ["conflict", "io_error"] as const) {
        const operationId = crypto.randomUUID();
        const before = await db.select().from(schema.contextCatalogCommits);
        const result = await receipts.execute(operationId, command, async () => {
          await port.mkdir("manuscript://rolled-back");
          return {
            ok: false,
            error: { code, uri: command.destinationUri, message: "injected failure" },
          };
        });
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
            uri: "manuscript://rolled-back",
            expected: { kind: "folder" },
          },
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
      await expect(port.write("scratch://@current-work/new.md", "blocked")).resolves.toMatchObject({
        ok: false,
        error: { code: "context_unavailable" },
      });
      await expect(
        port.commitWriterLocation(
          "scratch://@current-work/Untitled 1.md",
          "manuscript://moved.md",
          { expected: { kind: "file", nodeId: DOCUMENT_ID } },
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: "context_unavailable" } });
      const authority = createDrizzleProjectWorkAuthorityResolver(db);
      await expect(authority.byId(projectId, workId)).resolves.toMatchObject({ workId });
      expect((await documentOwner(DOCUMENT_ID)).sourceWorkId).toBe(workId);
      await db.update(schema.works).set({ archivedAt: null }).where(eq(schema.works.id, workId));
      await expect(
        port.commitWriterLocation(
          "scratch://@current-work/Untitled 1.md",
          "manuscript://moved.md",
          { expected: { kind: "file", nodeId: DOCUMENT_ID } },
        ),
      ).resolves.toMatchObject({ ok: true });
    });

    it("promotes scratch into manuscript, graduating provisional naming without touching Yjs authority", async () => {
      const { projectId, workId, collab, port } = await arrangeUntitled();
      const manifestBefore = await collab.resolveManifestMembership({ projectId });
      expect(manifestBefore.members.filter((id) => id === DOCUMENT_ID)).toEqual([DOCUMENT_ID]);
      const documentYjsBefore = await yjsState(DOCUMENT_ID);

      await expect(
        moveContextEntry({
          port,
          userId: USER_ID,
          sourceScheme: "scratch",
          body: {
            expected: { kind: "file", nodeId: DOCUMENT_ID },
            path: "Untitled 1.md",
            sourceWorkId: workId,
            destinationScheme: "manuscript",
            destinationFolderPath: "Act 1",
          },
        }),
      ).resolves.toEqual({
        status: "moved",
        linkUpdate: { links: 0, documents: 0 },
        scheme: "manuscript",
        path: "Act 1/Untitled 1.md",
        name: "Untitled 1.md",
      });

      const row = await promotedRow(projectId);
      expect(row).toMatchObject({
        id: DOCUMENT_ID,
        sourceSlug: "manuscript",
        sourceScope: "project",
        sourceWorkId: null,
        folderName: "Act 1",
        name: "Untitled 1",
        extension: "md",
        // An explicit writer placement ends provisional state even when the
        // name stays Untitled-N (D8 total graduation).
        provisionalName: false,
      });
      expect(row?.sourceId).toBe(row?.folderSourceId);
      await expect(port.stat(`scratch://@current-work/Untitled 1.md`)).resolves.toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
      await expect(port.stat("manuscript://Act 1/Untitled 1.md")).resolves.toMatchObject({
        ok: true,
        value: { documentId: DOCUMENT_ID },
      });

      const manifestAfter = await collab.resolveManifestMembership({ projectId });
      expect(manifestAfter.members.filter((id) => id === DOCUMENT_ID)).toEqual([DOCUMENT_ID]);
      expect(await yjsState(DOCUMENT_ID)).toEqual(documentYjsBefore);
    });

    it("durably moves one document from no-Work to a real Work and back", async () => {
      const { projectId, workId, port } = await arrangeUntitled();
      const created = await port.write("scratch://@/Unassigned.md", "portable", {
        origin: { type: "human", userId: USER_ID },
      });
      expect(created).toMatchObject({
        ok: true,
        value: { uri: "scratch://@/Unassigned.md", documentId: expect.any(String) },
      });
      if (!created.ok || !created.value.documentId) throw new Error("missing no-Work document");
      const documentId = created.value.documentId;
      const [noWork] = await db
        .select({ id: schema.works.id })
        .from(schema.works)
        .where(and(eq(schema.works.projectId, projectId), eq(schema.works.isNoWork, true)));
      await expect(documentOwner(documentId)).resolves.toMatchObject({
        documentId,
        sourceScope: "work",
        sourceWorkId: noWork?.id,
        sourceProjectId: null,
        folderName: null,
        documentName: "Unassigned",
        extension: "md",
      });

      await expect(
        moveContextEntry({
          port,
          userId: USER_ID,
          sourceScheme: "scratch",
          body: {
            expected: { kind: "file", nodeId: documentId },
            path: "Unassigned.md",
            sourceWorkId: null,
            destinationScheme: "scratch",
            destinationWorkId: workId,
            destinationFolderPath: "Assigned",
          },
        }),
      ).resolves.toEqual({
        status: "moved",
        linkUpdate: { links: 0, documents: 0 },
        scheme: "scratch",
        path: "Assigned/Unassigned.md",
        name: "Unassigned.md",
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
      await expect(
        port.stat("scratch://@current-work/Assigned/Unassigned.md"),
      ).resolves.toMatchObject({ ok: true, value: { documentId } });
      await expect(port.stat("scratch://@/Unassigned.md")).resolves.toMatchObject({
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
            path: "Assigned/Unassigned.md",
            sourceWorkId: workId,
            destinationScheme: "scratch",
            destinationWorkId: null,
            destinationFolderPath: "Returned",
          },
        }),
      ).resolves.toEqual({
        status: "moved",
        linkUpdate: { links: 0, documents: 0 },
        scheme: "scratch",
        path: "Returned/Unassigned.md",
        name: "Unassigned.md",
      });
      const returned = await documentOwner(documentId);
      expect(returned).toMatchObject({
        documentId,
        sourceScope: "work",
        sourceWorkId: noWork?.id,
        sourceProjectId: null,
        folderName: "Returned",
      });
      expect(returned?.documentSourceId).toBe(returned?.folderSourceId);
      await expect(port.stat("scratch://@/Returned/Unassigned.md")).resolves.toMatchObject({
        ok: true,
        value: { documentId },
      });
      await expect(
        port.stat("scratch://@current-work/Assigned/Unassigned.md"),
      ).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
    });

    it("graduates provisional naming in place on a deliberate stay-put", async () => {
      const { projectId, workId, collab, port } = await arrangeUntitled();
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
            path: "Untitled 1.md",
            sourceWorkId: workId,
            destinationScheme: "scratch",
            destinationWorkId: workId,
            destinationFolderPath: "",
          },
        }),
      ).resolves.toEqual({
        status: "moved",
        scheme: "scratch",
        path: "Untitled 1.md",
        name: "Untitled 1.md",
      });

      const rowAfter = await db
        .select()
        .from(schema.documents)
        .where(eq(schema.documents.id, DOCUMENT_ID));
      expect(rowAfter[0]).toEqual({ ...rowBefore[0], provisionalName: false });
      expect(await yjsState(DOCUMENT_ID)).toEqual(yjsBefore);
      const manifest = await collab.resolveManifestMembership({ projectId });
      expect(manifest.members.filter((id) => id === DOCUMENT_ID)).toEqual([DOCUMENT_ID]);
    });

    it("keeps provisional naming across a system move without the writer-placement option", async () => {
      const { projectId, port } = await arrangeUntitled();

      const moved = await port.move(
        `scratch://@current-work/Untitled 1.md`,
        "manuscript://Act 1/Untitled 1.md",
        { origin: { type: "human", userId: USER_ID } },
      );
      expect(moved).toMatchObject({ ok: true });

      // Generic ContextPort.move never silently graduates a document when only its container changes.
      await expect(promotedRow(projectId)).resolves.toMatchObject({
        folderName: "Act 1",
        name: "Untitled 1",
        provisionalName: true,
      });
    });

    it("moves a folder and its children across schemes", async () => {
      const { workId, port } = await arrangeUntitled();
      await expect(
        port.mkdir(`scratch://@current-work/Source/Nested`, {
          origin: { type: "human", userId: USER_ID },
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        port.write(`scratch://@current-work/Source/Nested/chapter.md`, "Chapter", {
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
      await expect(port.stat("manuscript://Act 1/Source/Nested/chapter.md")).resolves.toMatchObject(
        {
          ok: true,
        },
      );
      await expect(
        port.stat(`scratch://@current-work/Source/Nested/chapter.md`),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
    });

    it("returns the exact existing folder locator instead of nesting into it", async () => {
      const { workId, port } = await arrangeUntitled();
      await expect(port.mkdir(`scratch://@current-work/Source/Children`)).resolves.toMatchObject({
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
        status: "conflict",
        collision: {
          scheme: "manuscript",
          path: "Act 1/Source",
          authority: { kind: "project" },
        },
      });
      await expect(port.list("manuscript://Act 1/Source")).resolves.toEqual({
        ok: true,
        value: { uri: "manuscript://Act 1/Source", entries: [] },
      });
      await expect(port.list(`scratch://@current-work/Source`)).resolves.toMatchObject({
        ok: true,
      });
    });

    it("writes nothing into holders and counts only incoming links that name the moved documents", async () => {
      const { projectId, port } = await arrangeUntitled();
      const write = async (uri: string) => {
        const written = await port.write(uri, "Text.", {
          origin: { type: "human", userId: USER_ID },
        });
        if (!written.ok || !written.value.documentId) throw new Error(`write failed: ${uri}`);
        return written.value.documentId;
      };
      const target = await write("manuscript://Act 1/target.md");
      const unmoved = await write("manuscript://unmoved.md");
      const holder = await write("manuscript://holder.md");
      const aheadHolder = await write("manuscript://ahead-holder.md");
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
        .values({ id: otherHolder, contextSourceId: otherSource, name: "other", extension: "md" });
      const ahead = crypto.randomUUID();
      await db.insert(schema.linkAheadRefs).values({
        aheadId: ahead,
        projectId: projectId as never,
        scheme: "manuscript",
        path: "Act 1/target.md",
        settledDocumentId: target as never,
      });
      // Index rows as the certified derive writes them.
      const row = (sourceDocumentId: string, documentId: string, occurrences = 1) => ({
        sourceDocumentId: sourceDocumentId as never,
        linkKey: `doc:${documentId}`,
        targetDocumentId: documentId as never,
        address: "manuscript://x.md",
        occurrences,
      });
      await db.insert(schema.documentLinks).values([
        row(holder, target, 2),
        row(target, unmoved), // the moved document's own outgoing link
        row(otherHolder, target), // another project
        {
          sourceDocumentId: aheadHolder as never,
          linkKey: `ahead:${ahead}`,
          aheadId: ahead,
          address: "manuscript://Act 1/target.md",
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
            path: "Act 1/target.md",
            destinationScheme: "manuscript",
            destinationFolderPath: "",
            name: "renamed.md",
          },
        }),
      ).resolves.toMatchObject({ status: "moved", linkUpdate: { links: 3, documents: 2 } });
      expect(await yjsState(holder)).toEqual(holderState);
      expect(await yjsState(otherHolder)).toEqual(otherState);

      // A personal document moved into the project: only this project's holders count.
      const cast = await write("user://cast.md");
      await db.insert(schema.documentLinks).values([row(holder, cast), row(otherHolder, cast)]);
      await expect(port.move("user://cast.md", "kb://cast.md")).resolves.toMatchObject({
        ok: true,
        value: { linkUpdate: { links: 1, documents: 1 } },
      });
    });
  });
}
