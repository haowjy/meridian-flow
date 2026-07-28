/** Postgres regression coverage for bootstrap-owned durable document authority head. */

import { beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("project bootstrap document authority head (postgres)", () => {});
} else {
  describe("project bootstrap document authority head (postgres)", async () => {
    const { Hocuspocus } = await import("@hocuspocus/server");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createCollabDomain } = await import("../collab/composition.js");
    const { createProductionUnifiedContextPortFactory } = await import(
      "../context/unified-context-port-factory.js"
    );
    const { createDrizzleDocumentAccess } = await import("../../lib/document-access.js");
    const { createDrizzleProjectBootstrapRepository } = await import("./index.js");
    const { useRollbackTestDatabase } = await import(
      "../../test-support/rollback-test-database.js"
    );
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { eq } = await import("drizzle-orm");

    const USER_ID = "00000000-0000-4000-8000-000000000317";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => truncateDrizzleTables(db, [schema.users]),
    });
    let db = database.current;

    beforeEach(async () => {
      db = database.current;
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "bootstrap-authority"));
    });

    function createBoundCollab() {
      const collab = createCollabDomain({
        db,
        documentAccess: createDrizzleDocumentAccess(db),
      });
      const hocuspocus = new Hocuspocus({
        yDocOptions: { gc: false, gcFilter: () => true },
        onStoreDocument: ({ documentName, document }) =>
          collab.storeHocuspocusDocument(documentName, document),
      });
      collab.bindHocuspocus(hocuspocus);
      return { collab, hocuspocus };
    }

    it("treats repeated bootstrap as initialize-only and preserves writer content", async () => {
      const { collab } = createBoundCollab();
      const repository = createDrizzleProjectBootstrapRepository({ db, documents: collab });
      const first = await repository.ensureDefaultBootstrap(USER_ID as never);
      await collab.writeDocument({
        documentId: first.documentId,
        markdown: "Writer content\n",
        origin: { type: "user", actorUserId: USER_ID as never },
      });
      const checkpointsBefore = await db
        .select({ id: schema.documentYjsCheckpoints.id })
        .from(schema.documentYjsCheckpoints)
        .where(eq(schema.documentYjsCheckpoints.documentId, first.documentId));

      const second = await repository.ensureDefaultBootstrap(USER_ID as never);
      const checkpointsAfter = await db
        .select({ id: schema.documentYjsCheckpoints.id })
        .from(schema.documentYjsCheckpoints)
        .where(eq(schema.documentYjsCheckpoints.documentId, first.documentId));

      expect(second).toEqual(first);
      expect(await collab.readAsMarkdown(first.documentId)).toEqual({
        ok: true,
        value: "Writer content\n",
      });
      expect(checkpointsAfter).toHaveLength(checkpointsBefore.length);
    });

    it("exposes the freshly bootstrapped chapter through its thread context", async () => {
      const { collab } = createBoundCollab();
      const bootstrap = await createDrizzleProjectBootstrapRepository({
        db,
        documents: collab,
      }).ensureDefaultBootstrap(USER_ID as never);
      const contextPorts = createProductionUnifiedContextPortFactory({
        db,
        documentSync: collab,
        manifestMembership: collab,
      });
      const port = contextPorts.forWork(
        bootstrap.workId,
        bootstrap.projectId,
        USER_ID,
        new Set([bootstrap.workId]),
        bootstrap.threadId,
      );

      await expect(port.list("manuscript://")).resolves.toEqual({
        ok: true,
        value: [
          expect.objectContaining({
            kind: "file",
            documentId: bootstrap.documentId,
            uri: "manuscript://chapter-1.md",
          }),
        ],
      });
      await expect(port.read("manuscript://chapter-1.md")).resolves.toEqual({
        ok: true,
        value: {
          content: "# Chapter 1\n",
          documentId: bootstrap.documentId,
        },
      });
    });

    it("rolls back the whole bootstrap when document materialization is interrupted", async () => {
      const { collab, hocuspocus } = createBoundCollab();
      let interruptedDocumentId: string | undefined;
      const interrupted = createDrizzleProjectBootstrapRepository({
        db,
        documents: {
          ...collab,
          createDocumentAtomically: (input) => {
            interruptedDocumentId = input.documentId;
            return collab.createDocumentAtomically({
              ...input,
              async initializeContent() {
                await input.initializeContent();
                throw new Error("simulated interruption before document commit");
              },
            });
          },
        },
      });
      await expect(interrupted.ensureDefaultBootstrap(USER_ID as never)).rejects.toThrow(
        "simulated interruption",
      );
      await expect(
        Promise.all([
          db.select().from(schema.projects),
          db.select().from(schema.documents),
          db.select().from(schema.documentYjsCheckpoints),
          db.select().from(schema.documentYjsUpdates),
        ]).then((rows) => rows.map((row) => row.length)),
      ).resolves.toEqual([0, 0, 0, 0]);
      expect(interruptedDocumentId).toBeDefined();
      expect(hocuspocus.documents.has(interruptedDocumentId as string)).toBe(false);

      const repaired = await createDrizzleProjectBootstrapRepository({
        db,
        documents: collab,
      }).ensureDefaultBootstrap(USER_ID as never);

      expect(await collab.readAsMarkdown(repaired.documentId)).toEqual({
        ok: true,
        value: "# Chapter 1\n",
      });
    });

    it("repairs missing manifest membership without replacing writer content", async () => {
      const { collab } = createBoundCollab();
      const first = await createDrizzleProjectBootstrapRepository({
        db,
        documents: collab,
      }).ensureDefaultBootstrap(USER_ID as never);
      await collab.writeDocument({
        documentId: first.documentId,
        markdown: "Durable writer draft\n",
        origin: { type: "user", actorUserId: USER_ID as never },
      });
      await collab.recordManifestDocumentDeleted(first.documentId, {
        projectId: first.projectId,
      });
      await expect(
        collab.resolveManifestMembership({ projectId: first.projectId }),
      ).resolves.toMatchObject({ members: [] });

      await createDrizzleProjectBootstrapRepository({
        db,
        documents: collab,
      }).ensureDefaultBootstrap(USER_ID as never);

      await expect(
        collab.resolveManifestMembership({ projectId: first.projectId }),
      ).resolves.toMatchObject({ members: [first.documentId] });
      expect(await collab.readAsMarkdown(first.documentId)).toEqual({
        ok: true,
        value: "Durable writer draft\n",
      });
    });

    it("repairs a ghost on create resolution so create, list, and read share existence", async () => {
      const { collab } = createBoundCollab();
      const bootstrap = await createDrizzleProjectBootstrapRepository({
        db,
        documents: collab,
      }).ensureDefaultBootstrap(USER_ID as never);
      const view = {
        projectId: bootstrap.projectId,
        workId: bootstrap.workId,
        threadId: bootstrap.threadId,
      };
      await collab.recordManifestDocumentDeleted(bootstrap.documentId, view);
      const port = createProductionUnifiedContextPortFactory({
        db,
        documentSync: collab,
        manifestMembership: collab,
      }).forWork(
        bootstrap.workId,
        bootstrap.projectId,
        USER_ID,
        new Set([bootstrap.workId]),
        bootstrap.threadId,
      );
      await expect(port.list("manuscript://")).resolves.toEqual({ ok: true, value: [] });
      await expect(port.read("manuscript://chapter-1.md")).resolves.toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
      await expect(
        port.edit(
          "manuscript://chapter-1.md",
          {
            kind: "append",
            content: "Recovered edit",
          },
          {
            origin: {
              type: "human",
              userId: USER_ID,
              threadId: bootstrap.threadId,
            },
          },
        ),
      ).resolves.toMatchObject({ ok: true });
      await collab.recordManifestDocumentDeleted(bootstrap.documentId, view);

      await expect(
        port.ensureTrackedDocument("manuscript://chapter-1.md", {
          deferDocumentSync: true,
        }),
      ).resolves.toEqual({
        ok: true,
        value: { documentId: bootstrap.documentId, created: false },
      });
      await expect(port.list("manuscript://")).resolves.toMatchObject({
        ok: true,
        value: [expect.objectContaining({ documentId: bootstrap.documentId })],
      });
      await expect(port.read("manuscript://chapter-1.md")).resolves.toMatchObject({
        ok: true,
        value: {
          documentId: bootstrap.documentId,
          content: expect.stringContaining("Recovered edit"),
        },
      });
    });

    it("reconciles a warm empty Hocuspocus room with the committed seed", async () => {
      const { collab, hocuspocus } = createBoundCollab();
      let warmConnection: Awaited<ReturnType<typeof hocuspocus.openDirectConnection>> | undefined;
      const bootstrap = await createDrizzleProjectBootstrapRepository({
        db,
        documents: {
          ...collab,
          async seedFromMarkdown(documentId, markdown, origin) {
            warmConnection = await hocuspocus.openDirectConnection(documentId, {
              origin: { type: "system", reason: "bootstrap-race" },
            });
            return collab.seedFromMarkdown(documentId, markdown, origin);
          },
        },
      }).ensureDefaultBootstrap(USER_ID as never);

      expect(await collab.readAsMarkdown(bootstrap.documentId)).toEqual({
        ok: true,
        value: "# Chapter 1\n",
      });
      await warmConnection?.disconnect();
      const { collab: coldCollab } = createBoundCollab();
      expect(await coldCollab.readAsMarkdown(bootstrap.documentId)).toEqual({
        ok: true,
        value: "# Chapter 1\n",
      });
    });
  });
}
