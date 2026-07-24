/** Route seam coverage for create-with-content followed by the public read projection. */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("context create/read routes (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
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
    const { createDrizzleProjectRepository } = await import("../../domains/projects/index.js");
    const { createInMemoryObjectStore } = await import("../../domains/storage/index.js");
    const { handleContextReadRequest } = await import("../context-read-route.js");
    const { createDrizzleDocumentAccess } = await import("../document-access.js");
    const { useRollbackTestDatabase } = await import(
      "../../test-support/rollback-test-database.js"
    );
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { createContextEntry, parseCreateContextEntryBody } = await import(
      "../../routes/api/projects/[projectId]/context/[scheme]/create.post.js"
    );

    const USER_ID = "00000000-0000-4000-8000-000000000921";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000922";
    const WORK_ID = "00000000-0000-4000-8000-000000000923";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => truncateDrizzleTables(db, [schema.users]),
    });
    let db = database.current;

    beforeEach(async () => {
      db = database.current;
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "context-route"));
      await db
        .insert(schema.projects)
        .values({ id: PROJECT_ID, userId: USER_ID, name: "Project", slug: "project" });
    });

    for (const { path, schemaType } of [
      { path: "chapter.prose", schemaType: "document" },
      { path: "script.py", schemaType: "code" },
    ] as const) {
      it(`creates and reads ${path} with the ${schemaType} schema`, async () => {
        const collab = createCollabDomain({
          db,
          documentAccess: createDrizzleDocumentAccess(db),
          threads: { findById: async () => null },
        });
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
          manifestMembership: collab,
        });
        const port = contextPorts.forProject(PROJECT_ID, USER_ID);
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

    it.each([
      "cover.png",
      "report.pdf",
    ])("rejects binary-suffixed tracked create for %s without persisting a document", async (path) => {
      const collab = createCollabDomain({
        db,
        documentAccess: createDrizzleDocumentAccess(db),
        threads: { findById: async () => null },
      });
      collab.bindHocuspocus(
        new Hocuspocus({
          yDocOptions: { gc: false, gcFilter: () => true },
          onStoreDocument: ({ documentName, document }) =>
            collab.storeHocuspocusDocument(documentName, document),
        }),
      );
      const contextPorts = createProductionUnifiedContextPortFactory({
        db,
        documentSync: collab,
        manifestMembership: collab,
      });

      await expect(
        createContextEntry({
          port: contextPorts.forProject(PROJECT_ID, USER_ID),
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

    it("allows exactly one concurrent create and preserves the winner's content", async () => {
      const collab = createCollabDomain({
        db,
        documentAccess: createDrizzleDocumentAccess(db),
        threads: { findById: async () => null },
      });
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
        manifestMembership: collab,
      });
      const port = contextPorts.forProject(PROJECT_ID, USER_ID);
      const create = (content: string) =>
        createContextEntry({
          port,
          userId: USER_ID,
          scheme: "manuscript",
          workId: null,
          body: parseCreateContextEntryBody({ type: "file", path: "/race.md", content }),
        });

      const results = await Promise.all([create("alpha"), create("beta")]);
      expect(results.map((result) => result.status).sort()).toEqual(["conflict", "created"]);
      const winner = results.find((result) => result.status === "created");
      const read = await port.read("manuscript://race.md");
      expect(read).toEqual({
        ok: true,
        value: {
          content: winner === results[0] ? "alpha\n" : "beta\n",
          documentId: winner?.documentId,
        },
      });
    });

    it("registers kb and user documents and unregisters deleted documents", async () => {
      const collab = createCollabDomain({
        db,
        documentAccess: createDrizzleDocumentAccess(db),
        threads: { findById: async () => null },
      });
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
        manifestMembership: collab,
      });
      const port = contextPorts.forProject(PROJECT_ID, USER_ID);

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

      const kbDocumentId = await create(port, "kb", "/kb.md");
      await collab.drainHocuspocusPersistence();
      const kbMembership = await collab.resolveManifestMembership({
        projectId: PROJECT_ID as never,
      });
      expect(kbMembership.members).toContain(kbDocumentId);

      const userDocumentId = await create(port, "user", "/user.md");
      await collab.drainHocuspocusPersistence();
      const personalProject = (await db.select().from(schema.projects)).find(
        (project) => project.isPersonal,
      );
      if (!personalProject) throw new Error("user context project was not provisioned");
      const userMembership = await collab.resolveManifestMembership({
        projectId: personalProject.id as never,
      });
      expect(userMembership.members).toContain(userDocumentId);

      await expect(port.delete("user://user.md")).resolves.toEqual({
        ok: true,
        value: undefined,
      });
      await collab.drainHocuspocusPersistence();
      const deletedMembership = await collab.resolveManifestMembership({
        projectId: personalProject.id as never,
      });
      expect(deletedMembership.members).not.toContain(userDocumentId);
    });

    it("registers scratch documents in the live project manifest and resolves their project", async () => {
      await db.insert(schema.contextSources).values({
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        isPrimary: true,
      });
      await db.insert(schema.works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Scratch Work",
      });
      const collab = createCollabDomain({
        db,
        documentAccess: createDrizzleDocumentAccess(db),
        threads: { findById: async () => null },
      });
      const hocuspocus = new Hocuspocus({
        yDocOptions: { gc: false, gcFilter: () => true },
        onStoreDocument: ({ documentName, document }) =>
          collab.storeHocuspocusDocument(documentName, document),
      });
      collab.bindHocuspocus(hocuspocus);
      const contextPorts = createProductionUnifiedContextPortFactory({
        db,
        documentSync: collab,
        manifestMembership: collab,
      });
      const port = contextPorts.forWork(WORK_ID, PROJECT_ID, USER_ID, new Set([WORK_ID]));

      const created = await createContextEntry({
        port,
        userId: USER_ID,
        scheme: "scratch",
        workId: WORK_ID,
        body: parseCreateContextEntryBody({
          type: "file",
          path: "/notes.md",
          content: "scratch content",
        }),
      });
      if (created.status !== "created" || !created.documentId) {
        throw new Error("scratch creation did not return a document id");
      }

      await collab.drainHocuspocusPersistence();
      const liveMembership = await collab.resolveManifestMembership({
        projectId: PROJECT_ID as never,
      });
      expect(liveMembership.members).toContain(created.documentId);
      await expect(
        createDrizzleDocumentAccess(db).projectIdForDocument(created.documentId),
      ).resolves.toBe(PROJECT_ID);

      await expect(port.delete(`scratch://${WORK_ID}/notes.md`)).resolves.toEqual({
        ok: true,
        value: undefined,
      });
      await collab.drainHocuspocusPersistence();
      const membershipAfterDelete = await collab.resolveManifestMembership({
        projectId: PROJECT_ID as never,
      });
      expect(membershipAfterDelete.members).not.toContain(created.documentId);
    });

    it("only backfills observer-less scratch documents during explicit reconciliation", async () => {
      const projectSourceId = "00000000-0000-4000-8000-000000000925";
      const workSourceId = "00000000-0000-4000-8000-000000000926";
      const scratchDocumentId = "00000000-0000-4000-8000-000000000924";
      await db.insert(schema.contextSources).values({
        id: projectSourceId,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        isPrimary: true,
      });
      await db.insert(schema.works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Scratch Work",
      });
      const collab = createCollabDomain({
        db,
        documentAccess: createDrizzleDocumentAccess(db),
        threads: { findById: async () => null },
      });
      collab.bindHocuspocus(new Hocuspocus({ yDocOptions: { gc: false, gcFilter: () => true } }));

      await collab.resolveManifestMembership({ projectId: PROJECT_ID as never });

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
        name: "legacy-notes",
        extension: "md",
        fileType: "markdown",
      });

      await expect(
        collab.resolveManifestMembership({ projectId: PROJECT_ID as never }),
      ).resolves.toMatchObject({ members: [] });

      await collab.reconcileProjectManifest(PROJECT_ID as never);

      await expect(
        collab.resolveManifestMembership({ projectId: PROJECT_ID as never }),
      ).resolves.toMatchObject({ members: [scratchDocumentId] });
    });

    it("denies the websocket document path for Work content after project deletion", async () => {
      const workSourceId = "00000000-0000-4000-8000-000000000926";
      const scratchDocumentId = "00000000-0000-4000-8000-000000000924";
      await db.insert(schema.works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Deleted Project Work",
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
        extension: "md",
        fileType: "markdown",
      });
      await db
        .update(schema.projects)
        .set({ deletedAt: new Date() })
        .where(eq(schema.projects.id, PROJECT_ID));

      const access = createDrizzleDocumentAccess(db);
      await expect(access.canAccessDocument(USER_ID as never, scratchDocumentId)).resolves.toBe(
        false,
      );
      await expect(access.projectIdForDocument(scratchDocumentId)).resolves.toBeNull();
    });
  });
}
