/** Postgres-backed coverage for work-scoped untitled creation and manifest repair. */

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("context create-untitled route (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("context create-untitled route (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const { Hocuspocus } = await import("@hocuspocus/server");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createCollabDomain } = await import("../../domains/collab/composition.js");
    const { createProductionUnifiedContextPortFactory } = await import(
      "../../domains/context/unified-context-port-factory.js"
    );
    const { createDrizzleProjectBootstrapRepository } = await import(
      "../../domains/projects/index.js"
    );
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { createUntitledContextDocument } = await import(
      "../../routes/api/projects/[projectId]/context/[scheme]/create-untitled.post.js"
    );
    const { buildProjectContextTree } = await import(
      "../../routes/api/projects/[projectId]/context/[scheme]/tree.get.js"
    );

    const USER_ID = "00000000-0000-4000-8000-000000000931";
    const DOCUMENT_ID = "00000000-0000-4000-8000-000000000933";
    const REPAIR_DOCUMENT_ID = "00000000-0000-4000-8000-000000000934";
    const CROSS_SCHEME_DOCUMENT_ID = "00000000-0000-4000-8000-000000000935";
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
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "scratch-untitled"));
    });

    afterAll(async () => db.$client.end());

    async function provisionProject() {
      return createDrizzleProjectBootstrapRepository(db).ensureDefaultBootstrap(USER_ID as never);
    }

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

    it("registers a scratch untitled document in the live manifest used by the ws gate", async () => {
      const { projectId, workId } = await provisionProject();
      const collab = createBoundCollab();
      const contextPorts = createProductionUnifiedContextPortFactory({
        db,
        documentSync: collab,
        manifestMembership: collab,
      });
      const port = contextPorts.forWork(workId, projectId, USER_ID, new Set([workId]));

      await expect(
        createUntitledContextDocument({
          port,
          userId: USER_ID,
          scheme: "scratch",
          workId,
          body: { documentId: DOCUMENT_ID },
        }),
      ).resolves.toMatchObject({
        status: "created",
        documentId: DOCUMENT_ID,
        scheme: "scratch",
        path: "Untitled 1.md",
        name: "Untitled 1.md",
      });

      const treeResponse = () =>
        buildProjectContextTree({ projectId, scheme: "scratch", workId, port });
      await expect(treeResponse()).resolves.toMatchObject({
        projectId,
        scheme: "scratch",
        tree: {
          children: [
            expect.objectContaining({
              kind: "file",
              documentId: DOCUMENT_ID,
              name: "Untitled 1.md",
              provisionalName: true,
            }),
          ],
        },
      });

      await expect(
        port.move(`scratch://${workId}/Untitled 1.md`, `scratch://${workId}/Opening scene.md`, {
          origin: { type: "human", userId: USER_ID },
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(treeResponse()).resolves.toMatchObject({
        tree: {
          children: [
            expect.objectContaining({
              kind: "file",
              documentId: DOCUMENT_ID,
              name: "Opening scene.md",
              provisionalName: false,
            }),
          ],
        },
      });

      const membership = await collab.resolveManifestMembership({ projectId });
      expect(membership.members).toContain(DOCUMENT_ID);
      await expect(
        db.select().from(schema.contextSources).where(eq(schema.contextSources.workId, workId)),
      ).resolves.toEqual([expect.objectContaining({ workId, slug: "scratch", scope: "work" })]);
    });

    it("repairs scratch manifest membership when the same document id is retried", async () => {
      const { projectId, workId } = await provisionProject();
      const collab = createBoundCollab();
      let failNextMembershipWrite = true;
      const contextPorts = createProductionUnifiedContextPortFactory({
        db,
        documentSync: collab,
        manifestMembership: {
          async recordManifestDocumentCreated(documentId, view) {
            if (failNextMembershipWrite) {
              failNextMembershipWrite = false;
              throw new Error("simulated manifest membership failure");
            }
            await collab.recordManifestDocumentCreated(documentId, view);
          },
          recordManifestDocumentDeleted: (documentId, view) =>
            collab.recordManifestDocumentDeleted(documentId, view),
        },
      });
      const port = contextPorts.forWork(workId, projectId, USER_ID, new Set([workId]));
      const create = () =>
        createUntitledContextDocument({
          port,
          userId: USER_ID,
          scheme: "scratch",
          workId,
          body: { documentId: REPAIR_DOCUMENT_ID },
        });

      await expect(create()).rejects.toThrow("simulated manifest membership failure");
      await expect(create()).resolves.toMatchObject({
        status: "already-materialized",
        documentId: REPAIR_DOCUMENT_ID,
        path: "Untitled 1.md",
        name: "Untitled 1.md",
      });

      const membership = await collab.resolveManifestMembership({ projectId });
      expect(membership.members).toContain(REPAIR_DOCUMENT_ID);
      await expect(
        db.select().from(schema.documents).where(eq(schema.documents.id, REPAIR_DOCUMENT_ID)),
      ).resolves.toHaveLength(1);
    });

    it("recovers across schemes without materializing sources during the lookup scan", async () => {
      const { projectId, workId } = await provisionProject();
      const collab = createBoundCollab();
      const contextPorts = createProductionUnifiedContextPortFactory({
        db,
        documentSync: collab,
        manifestMembership: collab,
      });
      const port = contextPorts.forWork(workId, projectId, USER_ID, new Set([workId]));

      await expect(
        createUntitledContextDocument({
          port,
          userId: USER_ID,
          scheme: "manuscript",
          workId: null,
          body: { documentId: CROSS_SCHEME_DOCUMENT_ID },
        }),
      ).resolves.toMatchObject({ status: "created", scheme: "manuscript" });

      await expect(
        createUntitledContextDocument({
          port,
          userId: USER_ID,
          scheme: "scratch",
          workId,
          body: { documentId: CROSS_SCHEME_DOCUMENT_ID },
        }),
      ).resolves.toMatchObject({
        status: "already-materialized",
        scheme: "manuscript",
        documentId: CROSS_SCHEME_DOCUMENT_ID,
      });

      await expect(db.select().from(schema.contextSources)).resolves.toEqual([
        expect.objectContaining({ projectId, slug: "manuscript", scope: "project" }),
      ]);
    });
  });
}
