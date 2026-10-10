/** Postgres-backed coverage for work-scoped untitled creation and manifest repair. */

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDocumentLinkScopes,
  testLinkDeps,
} from "../../domains/collab/test-support/document-link-scopes.js";
import { createAllowAllFileAccess } from "../../domains/file-policy/index.js";
import { createProjectBootstrapRepositoryForTest as createDrizzleProjectBootstrapRepository } from "../../domains/projects/test-support/project-repository.js";
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
    const { createProductionUnifiedContextPortFactory } = await import(
      "../../domains/context/unified-context-port-factory.js"
    );
    const { createDrizzleContextCatalog } = await import(
      "../../domains/context/adapters/context-catalog.js"
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

    const USER_ID = "00000000-0000-4000-8000-000000000931";
    const _DOCUMENT_ID = "00000000-0000-4000-8000-000000000933";
    const REPAIR_DOCUMENT_ID = "00000000-0000-4000-8000-000000000934";
    const CROSS_SCHEME_DOCUMENT_ID = "00000000-0000-4000-8000-000000000935";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => deleteDrizzleRows(db, [schema.users]),
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

    const collabs: Array<{ dispose(): void }> = [];
    afterEach(() => {
      for (const collab of collabs.splice(0)) collab.dispose();
    });

    function createBoundCollab() {
      const collab = createCollabDomain({
        ...testLinkDeps(db),
        fileAccess: createAllowAllFileAccess(),
        db,
        workProjectionMutation: createTestWorkProjectionMutation(db),
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

    it("rolls back a failed scratch create so the same document id retries cleanly", async () => {
      const { projectId, workId } = await provisionProject();
      const collab = createBoundCollab();
      let failNextCatalogWrite = true;
      const catalog = createDrizzleContextCatalog(db);
      const contextPorts = createProductionUnifiedContextPortFactory({
        links: createTestDocumentLinkScopes(db),
        db,
        documentSync: collab,
        drafts: collab.drafts,
        catalogMutations: {
          async refreshSources(ids, invalidated) {
            if (failNextCatalogWrite) {
              failNextCatalogWrite = false;
              throw new Error("simulated catalog failure");
            }
            return catalog.refreshSources(ids, invalidated);
          },
        },
      });
      const authority = await createDrizzleProjectWorkAuthorityResolver(db).byId(projectId, workId);
      if (!authority) throw new Error("missing Work authority");
      const port = contextPorts.forWork(
        authority,
        projectId,
        USER_ID,
        authority.workSlug ? new Map([[authority.workSlug, authority]]) : new Map(),
      );
      const create = () =>
        createUntitledContextDocument({
          port,
          userId: USER_ID,
          scheme: "scratch",
          workId,
          body: { documentId: REPAIR_DOCUMENT_ID },
        });

      await expect(create()).rejects.toThrow("simulated catalog failure");
      await expect(create()).resolves.toMatchObject({
        status: "created",
        documentId: REPAIR_DOCUMENT_ID,
        path: "Untitled 1.md",
        name: "Untitled 1.md",
      });

      await expect(
        db.select().from(schema.documents).where(eq(schema.documents.id, REPAIR_DOCUMENT_ID)),
      ).resolves.toHaveLength(1);
    });

    it("recovers across schemes without materializing sources during the lookup scan", async () => {
      const { projectId, workId } = await provisionProject();
      const collab = createBoundCollab();
      const contextPorts = createProductionUnifiedContextPortFactory({
        links: createTestDocumentLinkScopes(db),
        db,
        documentSync: collab,
        drafts: collab.drafts,
      });
      const authority = await createDrizzleProjectWorkAuthorityResolver(db).byId(projectId, workId);
      if (!authority) throw new Error("missing Work authority");
      const port = contextPorts.forWork(
        authority,
        projectId,
        USER_ID,
        authority.workSlug ? new Map([[authority.workSlug, authority]]) : new Map(),
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
        expect.arrayContaining([
          expect.objectContaining({
            projectId,
            slug: "manuscript",
            scope: "project",
            workId: null,
          }),
          expect.objectContaining({ slug: "uploads", scope: "work", projectId: null }),
        ]),
      );
      await expect(
        db.select().from(schema.contextSources).where(eq(schema.contextSources.workId, workId)),
      ).resolves.toEqual([]);
    });
  });
}
