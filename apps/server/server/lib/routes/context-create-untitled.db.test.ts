/** Postgres-backed coverage for work-scoped untitled creation and manifest repair. */

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("context create-untitled route (postgres)", () => {});
} else {
  describe("context create-untitled route (postgres)", async () => {
    const { Hocuspocus } = await import("@hocuspocus/server");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createCollabDomain } = await import("../../domains/collab/composition.js");
    const { createDrizzleDocumentAccess } = await import("../document-access.js");
    const { createProductionUnifiedContextPortFactory } = await import(
      "../../domains/context/unified-context-port-factory.js"
    );
    const { createDrizzleContextCatalog } = await import(
      "../../domains/context/adapters/context-catalog.js"
    );
    const { createDrizzleProjectBootstrapRepository, createDrizzleProjectWorkAuthorityResolver } =
      await import("../../domains/projects/index.js");
    const { useRollbackTestDatabase } = await import(
      "../../test-support/rollback-test-database.js"
    );
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { createUntitledContextDocument } = await import(
      "../../routes/api/projects/[projectId]/context/[scheme]/create-untitled.post.js"
    );

    const USER_ID = "00000000-0000-4000-8000-000000000931";
    const DOCUMENT_ID = "00000000-0000-4000-8000-000000000933";
    const REPAIR_DOCUMENT_ID = "00000000-0000-4000-8000-000000000934";
    const CROSS_SCHEME_DOCUMENT_ID = "00000000-0000-4000-8000-000000000935";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => truncateDrizzleTables(db, [schema.users]),
    });
    let db = database.current;

    beforeEach(async () => {
      db = database.current;
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "scratch-untitled"));
    });

    async function provisionProject() {
      const bootstrap = await createDrizzleProjectBootstrapRepository({
        db,
        documents: createBoundCollab(),
      }).ensureDefaultBootstrap(USER_ID as never);
      const workId = crypto.randomUUID();
      await db.insert(schema.works).values({
        id: workId,
        projectId: bootstrap.projectId,
        createdByUserId: USER_ID,
        name: "Current Work",
        slug: "current-work",
      });
      return { ...bootstrap, workId };
    }

    function createBoundCollab() {
      const collab = createCollabDomain({
        db,
        workProjectionMutation: createTestWorkProjectionMutation(db),
        workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
        documentAccess: createDrizzleDocumentAccess(db),
      });
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
      const catalog = createDrizzleContextCatalog(db);
      const contextPorts = createProductionUnifiedContextPortFactory({
        db,
        documentSync: collab,
        manifestMembership: collab,
        catalogMutations: catalog,
      });
      const authority = await createDrizzleProjectWorkAuthorityResolver(db).byId(projectId, workId);
      if (!authority) throw new Error("missing Work authority");
      const port = contextPorts.forWork(
        authority,
        projectId,
        USER_ID,
        new Map([[authority.workSlug, authority]]),
      );

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

      await expect(
        catalog.lookup({
          scope: { kind: "work", projectId, workId },
          entryId: DOCUMENT_ID,
        }),
      ).resolves.toMatchObject({
        entry: {
          kind: "file",
          entryId: DOCUMENT_ID,
          name: "Untitled 1.md",
          provisionalName: true,
        },
      });

      await expect(
        port.move(
          `scratch://@current-work/Untitled 1.md`,
          `scratch://@current-work/Opening scene.md`,
          {
            origin: { type: "human", userId: USER_ID },
          },
        ),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        catalog.lookup({
          scope: { kind: "work", projectId, workId },
          entryId: DOCUMENT_ID,
        }),
      ).resolves.toMatchObject({
        entry: {
          kind: "file",
          entryId: DOCUMENT_ID,
          name: "Opening scene.md",
          provisionalName: false,
        },
      });

      const membership = await collab.resolveManifestMembership({ projectId });
      expect(membership.members).toContain(DOCUMENT_ID);
      await expect(
        db.select().from(schema.contextSources).where(eq(schema.contextSources.workId, workId)),
      ).resolves.toEqual([expect.objectContaining({ workId, slug: "scratch", scope: "work" })]);
    });

    it("rolls back a failed scratch create so the same document id retries cleanly", async () => {
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
      const authority = await createDrizzleProjectWorkAuthorityResolver(db).byId(projectId, workId);
      if (!authority) throw new Error("missing Work authority");
      const port = contextPorts.forWork(
        authority,
        projectId,
        USER_ID,
        new Map([[authority.workSlug, authority]]),
      );
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
        status: "created",
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
      const authority = await createDrizzleProjectWorkAuthorityResolver(db).byId(projectId, workId);
      if (!authority) throw new Error("missing Work authority");
      const port = contextPorts.forWork(
        authority,
        projectId,
        USER_ID,
        new Map([[authority.workSlug, authority]]),
      );

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

      await expect(db.select().from(schema.contextSources)).resolves.toEqual(
        expect.arrayContaining(
          ["manuscript", "scratch", "uploads"].map((slug) =>
            expect.objectContaining({ projectId, slug, scope: "project", workId: null }),
          ),
        ),
      );
      await expect(
        db.select().from(schema.contextSources).where(eq(schema.contextSources.workId, workId)),
      ).resolves.toEqual([]);
    });
  });
}
