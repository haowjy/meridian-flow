/** Postgres-backed coverage for promoting work-scoped scratch documents. */

import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("context move route (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("context move route (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const { Hocuspocus } = await import("@hocuspocus/server");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createCollabDomain } = await import("../../../../../../domains/collab/composition.js");
    const { createProductionUnifiedContextPortFactory } = await import(
      "../../../../../../domains/context/unified-context-port-factory.js"
    );
    const { createDrizzleProjectBootstrapRepository } = await import(
      "../../../../../../domains/projects/index.js"
    );
    const { truncateDrizzleTables } = await import(
      "../../../../../../test-support/drizzle-reset.js"
    );
    const { createUntitledContextDocument } = await import("./create-untitled.post.js");
    const { commitContextMove, parseContextMove } = await import(
      "../../../../../../lib/context-move-route.js"
    );
    const moveContextEntry = (input: {
      port: import("../../../../../../domains/context/index.js").ContextPort;
      userId: string;
      sourceScheme: string;
      body: unknown;
    }) =>
      commitContextMove({
        port: input.port,
        userId: input.userId,
        move: parseContextMove({ sourceScheme: input.sourceScheme, body: input.body }),
      });

    const USER_ID = "00000000-0000-4000-8000-000000000941";
    const DOCUMENT_ID = "00000000-0000-4000-8000-000000000942";
    const db = createDb(DATABASE_URL, { max: 4 });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [
        schema.branchWriteJournal,
        schema.pushLineage,
        schema.documentBranches,
        schema.documentYjsCheckpoints,
        schema.documentYjsHeads,
        schema.documentYjsUpdates,
        schema.folders,
        schema.documents,
        schema.contextSources,
        schema.works,
        schema.projects,
        schema.users,
      ]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "scratch-promotion"));
    });

    afterAll(async () => db.$client.end());

    function createBoundCollab() {
      const collab = createCollabDomain({ db, threads: { findById: async () => null } });
      collab.bindHocuspocus(
        new Hocuspocus({
          yDocOptions: { gc: false, gcFilter: () => true },
          onStoreDocument: ({ documentName, document }) =>
            collab.storeHocuspocusDocument(documentName, document),
        }),
      );
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
      const { projectId, workId } = await createDrizzleProjectBootstrapRepository(
        db,
      ).ensureDefaultBootstrap(USER_ID as never);
      const collab = createBoundCollab();
      const contextPorts = createProductionUnifiedContextPortFactory({
        db,
        documentSync: collab,
        manifestMembership: collab,
      });
      const port = contextPorts.forWork(workId, projectId, USER_ID, new Set([workId]));
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
            path: "Untitled 1.md",
            sourceWorkId: workId,
            destinationScheme: "manuscript",
            destinationFolderPath: "Act 1",
          },
        }),
      ).resolves.toEqual({
        status: "moved",
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
      await expect(port.stat(`scratch://${workId}/Untitled 1.md`)).resolves.toMatchObject({
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
      const { projectId, workId, port } = await arrangeUntitled();

      const moved = await port.move(
        `scratch://${workId}/Untitled 1.md`,
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

    it("clears provisional naming when the move renames", async () => {
      const { projectId, workId, port } = await arrangeUntitled();

      await expect(
        moveContextEntry({
          port,
          userId: USER_ID,
          sourceScheme: "scratch",
          body: {
            path: "Untitled 1.md",
            sourceWorkId: workId,
            destinationScheme: "manuscript",
            destinationFolderPath: "Act 1",
            newName: "Opening.md",
          },
        }),
      ).resolves.toEqual({
        status: "moved",
        scheme: "manuscript",
        path: "Act 1/Opening.md",
        name: "Opening.md",
      });

      await expect(promotedRow(projectId)).resolves.toMatchObject({
        name: "Opening",
        extension: "md",
        provisionalName: false,
      });
    });

    it("moves a folder and its children across schemes", async () => {
      const { workId, port } = await arrangeUntitled();
      await expect(
        port.mkdir(`scratch://${workId}/Source/Nested`, {
          origin: { type: "human", userId: USER_ID },
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        port.write(`scratch://${workId}/Source/Nested/chapter.md`, "Chapter", {
          origin: { type: "human", userId: USER_ID },
        }),
      ).resolves.toMatchObject({ ok: true });

      await expect(
        moveContextEntry({
          port,
          userId: USER_ID,
          sourceScheme: "scratch",
          body: {
            path: "Source",
            sourceWorkId: workId,
            destinationScheme: "manuscript",
            destinationFolderPath: "Act 1",
          },
        }),
      ).resolves.toEqual({
        status: "moved",
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
        port.stat(`scratch://${workId}/Source/Nested/chapter.md`),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
    });

    it("returns the exact existing folder locator instead of nesting into it", async () => {
      const { workId, port } = await arrangeUntitled();
      await expect(port.mkdir(`scratch://${workId}/Source/Children`)).resolves.toMatchObject({
        ok: true,
      });
      await expect(port.mkdir("manuscript://Act 1/Source")).resolves.toMatchObject({ ok: true });

      await expect(
        moveContextEntry({
          port,
          userId: USER_ID,
          sourceScheme: "scratch",
          body: {
            path: "Source",
            sourceWorkId: workId,
            destinationScheme: "manuscript",
            destinationFolderPath: "Act 1",
          },
        }),
      ).resolves.toEqual({
        status: "conflict",
        collision: { scheme: "manuscript", path: "Act 1/Source" },
      });
      await expect(port.list("manuscript://Act 1/Source")).resolves.toEqual({
        ok: true,
        value: [],
      });
      await expect(port.list(`scratch://${workId}/Source`)).resolves.toMatchObject({ ok: true });
    });
  });
}
