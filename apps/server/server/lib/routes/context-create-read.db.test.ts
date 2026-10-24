/** Route seam coverage for create-with-content followed by the public read projection. */

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createContextEntry as createClientContextEntry } from "../../../../app/src/client/api/projects-api.js";
import {
  createTestDocumentLinkScopes,
  testLinkDeps,
} from "../../domains/collab/test-support/document-link-scopes.js";
import { createDrizzleContextCatalog } from "../../domains/context/adapters/context-catalog.js";
import { createDrizzleLineageScratchLifecycle } from "../../domains/context/adapters/lineage-scratch-lifecycle.js";
import {
  createAllowAllFileAccess,
  createLocalFileAccessChanges,
} from "../../domains/file-policy/index.js";
import { createDrizzleProjectWorkRepository } from "../../domains/projects/index.js";
import { createProjectRepositoryForTest } from "../../domains/projects/test-support/project-repository.js";
import {
  createTestDocumentRemoval,
  createTestRemovalDeps,
} from "../../test-support/document-removal.js";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("context create/read routes (postgres)", () => {});
} else {
  describe("context create/read routes (postgres)", async () => {
    const { Hocuspocus } = await import("@hocuspocus/server");
    const { Schema } = await import("prosemirror-model");
    const { yXmlFragmentToProsemirrorJSON } = await import("y-prosemirror");
    const { documentMarks, documentNodes } = await import("@meridian/prosemirror-schema");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createCollabDomain } = await import("../../domains/collab/composition.js");
    const { createProductionUnifiedContextPortFactory } = await import(
      "../../domains/context/unified-context-port-factory.js"
    );
    const { createNoopEventSink } = await import("../../domains/observability/index.js");
    const { createDrizzleProjectWorkAuthorityResolver } = await import(
      "../../domains/projects/index.js"
    );
    const createDrizzleProjectRepository = createProjectRepositoryForTest;
    const { createInMemoryObjectStore } = await import("../../domains/storage/index.js");
    const { handleContextReadRequest } = await import("../context-read-route.js");
    const { drizzleFileAccess } = await import("../../test-support/file-grants.js");
    const { containerTarget, requireFileGrant, withEditGrants } = await import(
      "../file-access-http.js"
    );
    const { useRollbackTestDatabase, deleteDrizzleRows } = await import(
      "../../test-support/drizzle-reset.js"
    );
    const { createContextEntry, parseCreateContextEntryBody } = await import(
      "../../routes/api/projects/[projectId]/context/[scheme]/create.post.js"
    );

    const USER_ID = "00000000-0000-4000-8000-000000000921";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000922";
    const WORK_ID = "00000000-0000-4000-8000-000000000923";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => deleteDrizzleRows(db, [schema.users]),
    });
    let db = database.current;
    const fixtures: Array<{
      collab: ReturnType<typeof createCollabDomain>;
      hocuspocus: InstanceType<typeof Hocuspocus>;
    }> = [];

    beforeEach(async () => {
      db = database.current;
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "context-route"));
      await db
        .insert(schema.projects)
        .values({ id: PROJECT_ID, userId: USER_ID, name: "Project", slug: "project" });
    });

    function createFixture(options: { load?: boolean; store?: boolean } = {}) {
      const collab = createCollabDomain({
        ...testLinkDeps(db),
        fileAccess: createAllowAllFileAccess(),
        db,
        ...createTestRemovalDeps(db),
        workProjectionMutation: createTestWorkProjectionMutation(db),
        catalogMutations: createDrizzleContextCatalog(db),
      });
      const hocuspocus = new Hocuspocus({
        yDocOptions: { gc: false, gcFilter: () => true },
        ...(options.load === false
          ? {}
          : {
              async onLoadDocument({ documentName, document }) {
                const state = await collab.loadHocuspocusDocument(documentName, document);
                if (state) Y.applyUpdate(document, state);
              },
            }),
        ...(options.store === false
          ? {}
          : {
              onStoreDocument: ({ documentName, document }) =>
                collab.storeHocuspocusDocument(documentName, document),
            }),
      });
      collab.bindHocuspocus(hocuspocus);
      fixtures.push({ collab, hocuspocus });
      return {
        collab,
        hocuspocus,
        contextPorts: createProductionUnifiedContextPortFactory({
          pendingBranch: createTestWorkProjectionMutation(db),
          links: createTestDocumentLinkScopes(db),
          db,
          removal: createTestDocumentRemoval(db),
          documentSync: collab,
          branches: collab.branches,
        }),
      };
    }

    afterEach(async () => {
      for (const { collab, hocuspocus } of fixtures.splice(0)) {
        hocuspocus.closeConnections();
        hocuspocus.flushPendingStores();
        await collab.drainHocuspocusPersistence();
        collab.dispose();
      }
    });

    for (const { path, schemaType } of [
      { path: "chapter.prose", schemaType: "document" },
      { path: "script.py", schemaType: "code" },
    ] as const) {
      it(`creates and reads ${path} with the ${schemaType} schema`, async () => {
        const { collab, hocuspocus, contextPorts } = createFixture();
        const port = contextPorts.forProject(PROJECT_ID, USER_ID, new Map());
        const content =
          schemaType === "code" ? "print('hello')\n" : `Initial content for ${path}.\n`;

        const created = await createContextEntry({
          port,
          userId: USER_ID,
          scheme: "manuscript",
          workId: null,
          body: parseCreateContextEntryBody({ type: "file", path: `/${path}`, content }),
        });

        if (created.status !== "created" || !created.documentId)
          throw new Error("file creation did not return a document id");
        const room = await hocuspocus.openDirectConnection(created.documentId);
        await room.disconnect();

        await expect(port.stat(`manuscript://${path}`)).resolves.toMatchObject({
          ok: true,
          value: { kind: "tracked", schemaType },
        });

        const materialized = new Y.Doc();
        const state = await collab.loadHocuspocusDocument(created.documentId);
        if (!state) throw new Error("created document did not materialize journal state");
        Y.applyUpdate(materialized, state);
        const json = yXmlFragmentToProsemirrorJSON(materialized.getXmlFragment("prosemirror"));
        const mountedSchema = new Schema({
          nodes:
            schemaType === "code"
              ? { ...documentNodes, doc: { content: "code_block" } }
              : documentNodes,
          marks: documentMarks,
        });
        const mountedDocument = mountedSchema.nodeFromJSON(json);
        expect(() => mountedDocument.check()).not.toThrow();
        expect(mountedDocument.firstChild?.type.name).toBe(
          schemaType === "code" ? "code_block" : "paragraph",
        );

        await expect(
          handleContextReadRequest(
            {
              fileAccess: drizzleFileAccess(db),
              projectRepo: createDrizzleProjectRepository({ db }),
              workRepo: createDrizzleProjectWorkRepository({
                removal: createTestDocumentRemoval(db),
                db,
                lineageScratch: createDrizzleLineageScratchLifecycle(db),
                fileAccessChanges: createLocalFileAccessChanges(),
                projectionMutation: createTestWorkProjectionMutation(db),
              }),
              contextPorts,
              objectStore: createInMemoryObjectStore(),
              eventSink: createNoopEventSink(),
              workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
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

    it.each([
      "cover.png",
    ])("rejects binary-suffixed tracked create for %s without persisting a document", async (path) => {
      const { contextPorts } = createFixture({ load: false });

      await expect(
        createContextEntry({
          port: contextPorts.forProject(PROJECT_ID, USER_ID, new Map()),
          userId: USER_ID,
          scheme: "manuscript",
          workId: null,
          body: parseCreateContextEntryBody({
            type: "file",
            path: `/${path}`,
            content: "not binary content",
          }),
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/binary.*upload/i),
      });
      await expect(db.select().from(schema.documents)).resolves.toHaveLength(0);
    });

    it.each([
      { occupant: "folder", existing: "outline.json", type: "file", path: "outline.json" },
      { occupant: "file", existing: "Taken", type: "folder", path: "Taken.md" },
    ] as const)("carries a server-discovered $occupant conflict through the create HTTP client", async ({
      occupant,
      existing,
      type,
      path,
    }) => {
      const { contextPorts } = createFixture();
      const port = contextPorts.forProject(PROJECT_ID, USER_ID, new Map());
      await createContextEntry({
        port,
        userId: USER_ID,
        scheme: "manuscript",
        body: { type: occupant, path: existing },
      });
      const body = { type, path };
      // No sibling snapshot is supplied: the route, not the app, discovers the clash.
      const result = await createContextEntry({
        port,
        userId: USER_ID,
        scheme: "manuscript",
        body,
      });
      expect(result).toMatchObject({ status: "conflict", occupantKind: occupant });
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify(result), {
              status: 409,
              headers: { "content-type": "application/json" },
            }),
        ),
      );
      try {
        await expect(createClientContextEntry(PROJECT_ID, "manuscript", body)).resolves.toEqual(
          result,
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("allows exactly one concurrent create and preserves the winner's content", async () => {
      const { contextPorts } = createFixture();
      const port = contextPorts.forProject(PROJECT_ID, USER_ID, new Map());
      const create = (content: string) =>
        createContextEntry({
          port,
          userId: USER_ID,
          scheme: "manuscript",
          workId: null,
          body: parseCreateContextEntryBody({ type: "file", path: "/race", content }),
        });

      const results = await Promise.all([create("alpha"), create("beta")]);
      expect(results.map((result) => result.status).sort()).toEqual(["conflict", "created"]);
      const winner = results.find((result) => result.status === "created");
      const read = await port.read("manuscript://race");
      expect(read).toEqual({
        ok: true,
        value: {
          content: winner === results[0] ? "alpha\n" : "beta\n",
          documentId: winner?.documentId,
          uri: "manuscript://race",
        },
      });
    });

    it("creates kb and user documents and hides deleted documents", async () => {
      const { collab, contextPorts } = createFixture();
      const port = contextPorts.forProject(PROJECT_ID, USER_ID, new Map());

      const create = async (targetPort: typeof port, scheme: "kb" | "user", path: string) => {
        const result = await createContextEntry({
          port: targetPort,
          userId: USER_ID,
          scheme,
          workId: null,
          body: parseCreateContextEntryBody({ type: "file", path, content: `${scheme} content` }),
        });
        if (result.status !== "created" || !result.documentId)
          throw new Error(`${scheme} creation did not return a document id`);
        return result.documentId;
      };

      const kbDocumentId = await create(port, "kb", "/kb");
      await collab.drainHocuspocusPersistence();
      await expect(port.stat("kb://kb.md")).resolves.toMatchObject({
        ok: true,
        value: { documentId: kbDocumentId },
      });

      const userDocumentId = await create(port, "user", "/user");
      await collab.drainHocuspocusPersistence();
      const personalProject = (await db.select().from(schema.projects)).find(
        (project) => project.isPersonal,
      );
      if (!personalProject) throw new Error("user context project was not provisioned");
      await expect(port.stat("user://user.md")).resolves.toMatchObject({
        ok: true,
        value: { documentId: userDocumentId },
      });

      await expect(
        port.delete("user://user", {
          expected: { kind: "file", documentId: userDocumentId },
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          status: "deleted",
          removed: [
            {
              documentId: userDocumentId,
              removal: {
                time: expect.any(String),
                locationVersion: expect.stringMatching(/^[1-9]\d*$/),
              },
            },
          ],
          availabilityGeneration: expect.not.stringMatching(/^0$/),
        },
      });
      await collab.drainHocuspocusPersistence();
      await expect(port.stat("user://user.md")).resolves.toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
    });

    it("refuses a writer's create in an archived Work's scratch before anything is written", async () => {
      await db.insert(schema.works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Archived",
        handle: "w1",
        archivedAt: new Date(),
      });
      const { contextPorts } = createFixture({ load: false });
      const authority = await createDrizzleProjectWorkAuthorityResolver(db).byId(
        PROJECT_ID,
        WORK_ID,
      );
      if (!authority?.workHandle) throw new Error("missing Work authority");
      const port = contextPorts.forWork(
        authority,
        PROJECT_ID,
        USER_ID,
        new Map([[authority.workHandle, authority]]),
      );
      const fileAccess = drizzleFileAccess(db);
      const container = await containerTarget(
        { findNoWork: async () => null },
        { projectId: PROJECT_ID, scheme: "scratch", workId: WORK_ID },
      );
      // As the create route does: the container grant first, then the write.
      const create = async () =>
        withEditGrants(
          fileAccess,
          [await requireFileGrant(fileAccess, USER_ID, container, "edit")],
          () =>
            createContextEntry({
              port,
              userId: USER_ID,
              scheme: "scratch",
              workId: WORK_ID,
              body: parseCreateContextEntryBody({ type: "file", path: "/notes", content: "x" }),
            }),
        );

      await expect(create()).rejects.toMatchObject({
        status: 403,
        data: { __meridianInterruptEnvelope: { error: { code: "work_archived" } } },
      });
      await expect(db.select({ id: schema.documents.id }).from(schema.documents)).resolves.toEqual(
        [],
      );
    });

    it("lists an archived Work with no scratch source as empty without provisioning", async () => {
      await db.insert(schema.works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Empty archived Work",
        handle: "w2",
        archivedAt: new Date(),
      });
      const { contextPorts } = createFixture({ load: false });
      const authority = await createDrizzleProjectWorkAuthorityResolver(db).byId(
        PROJECT_ID,
        WORK_ID,
      );
      if (!authority?.workHandle) throw new Error("missing Work authority");
      const port = contextPorts.forWork(
        authority,
        PROJECT_ID,
        USER_ID,
        new Map([[authority.workHandle, authority]]),
      );

      await expect(port.list(`scratch://@${authority.workHandle}/`)).resolves.toMatchObject({
        ok: true,
        value: { entries: [] },
      });
      await expect(
        db.select().from(schema.contextSources).where(eq(schema.contextSources.workId, WORK_ID)),
      ).resolves.toEqual([]);
    });

    it("denies the websocket document path for Work content after project deletion", async () => {
      const workSourceId = "00000000-0000-4000-8000-000000000926";
      const scratchDocumentId = "00000000-0000-4000-8000-000000000924";
      await db.insert(schema.works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Deleted Project Work",
        handle: "w3",
      });
      await db.insert(schema.contextSources).values({
        id: workSourceId,
        workId: WORK_ID,
        name: "Scratch",
        slug: "scratch",
        scope: "work",
      });
      await db.insert(schema.documents).values({
        id: scratchDocumentId,
        contextSourceId: workSourceId,
        name: "retained-id",
        extension: "",
        fileType: "markdown",
      });
      await db
        .update(schema.projects)
        .set({ deletedAt: new Date() })
        .where(eq(schema.projects.id, PROJECT_ID));

      await expect(
        drizzleFileAccess(db).authorize(
          { accountId: USER_ID as never },
          { kind: "document", documentId: scratchDocumentId as never },
          "read",
        ),
      ).resolves.toMatchObject({ denied: true, reason: "not_found" });
    });
  });
}
