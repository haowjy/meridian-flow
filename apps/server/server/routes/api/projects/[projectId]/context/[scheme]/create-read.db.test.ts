/** Route seam coverage for create-with-content followed by the public read projection. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("context create/read routes (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("context create/read routes (postgres)", async () => {
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
    const { createNoopEventSink } = await import(
      "../../../../../../domains/observability/index.js"
    );
    const { createDrizzleProjectRepository } = await import(
      "../../../../../../domains/projects/index.js"
    );
    const { createInMemoryObjectStore } = await import(
      "../../../../../../domains/storage/index.js"
    );
    const { handleContextReadRequest } = await import(
      "../../../../../../lib/context-read-route.js"
    );
    const { truncateDrizzleTables } = await import(
      "../../../../../../test-support/drizzle-reset.js"
    );
    const { createContextEntry, parseCreateContextEntryBody } = await import("./create.post.js");

    const USER_ID = "00000000-0000-4000-8000-000000000921";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000922";
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
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "context-route"));
      await db
        .insert(schema.projects)
        .values({ id: PROJECT_ID, userId: USER_ID, name: "Project", slug: "project" });
    });

    afterAll(async () => db.$client.end());

    for (const path of ["chapter.md", "extensionless"]) {
      it(`returns initial content through the read route for ${path}`, async () => {
        const collab = createCollabDomain({ db, threads: { findById: async () => null } });
        const hocuspocus = new Hocuspocus({
          yDocOptions: { gc: false, gcFilter: () => true },
          async onLoadDocument({ documentName, document }) {
            const state = await collab.loadHocuspocusDocument(documentName);
            if (state) Y.applyUpdate(document, state);
          },
          onStoreDocument: ({ documentName, document }) =>
            collab.storeHocuspocusDocument(documentName, document),
        });
        collab.bindHocuspocus(hocuspocus);
        const contextPorts = createProductionUnifiedContextPortFactory({
          db,
          documentSync: collab,
        });
        const port = contextPorts.forProject(PROJECT_ID, USER_ID);
        const content = `Initial content for ${path}.\n`;

        const created = await createContextEntry({
          port,
          userId: USER_ID,
          scheme: "manuscript",
          workId: null,
          body: parseCreateContextEntryBody({ type: "file", path: `/${path}`, content }),
        });

        if (!created.documentId) throw new Error("file creation did not return a document id");
        const room = await hocuspocus.openDirectConnection(created.documentId);
        await room.disconnect();

        await expect(
          handleContextReadRequest(
            {
              projectRepo: createDrizzleProjectRepository({ db }),
              workRepo: {} as never,
              contextPorts,
              objectStore: createInMemoryObjectStore(),
              eventSink: createNoopEventSink(),
            },
            {
              projectId: PROJECT_ID,
              userId: USER_ID,
              scheme: "manuscript",
              rawPath: `/${path}`,
            },
          ),
        ).resolves.toMatchObject({ kind: "tracked", content });
      });
    }
  });
}
