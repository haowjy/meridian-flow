/** PostgreSQL contract for Work-free project bootstrap. */

import { beforeEach, describe, expect, it } from "vitest";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";

const RUN = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN || !DATABASE_URL) describe.skip("Work-free project bootstrap (postgres)", () => {});
else
  describe("Work-free project bootstrap (postgres)", async () => {
    const { Hocuspocus } = await import("@hocuspocus/server");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { eq } = await import("drizzle-orm");
    const { createCollabDomain } = await import("../collab/composition.js");
    const { createDrizzleDocumentAccess } = await import("../../lib/document-access.js");
    const { useRollbackTestDatabase } = await import(
      "../../test-support/rollback-test-database.js"
    );
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { createDrizzleProjectBootstrapRepository, createDrizzleProjectWorkAuthorityResolver } =
      await import("./index.js");
    const { createProjectContextDocumentStore } = await import(
      "../context/context-source-provisioning.js"
    );
    const { runInDrizzleTransaction } = await import("../../shared/drizzle-transaction.js");
    const USER_ID = "00000000-0000-4000-8000-000000000751";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => truncateDrizzleTables(db, [schema.users]),
    });
    let db = database.current;
    beforeEach(async () => {
      db = database.current;
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "no-work-bootstrap"));
    });
    function collab() {
      const domain = createCollabDomain({
        db,
        workProjectionMutation: createTestWorkProjectionMutation(db),
        workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
        documentAccess: createDrizzleDocumentAccess(db),
      });
      domain.bindHocuspocus(
        new Hocuspocus({
          yDocOptions: { gc: false, gcFilter: () => true },
          onStoreDocument: ({ documentName, document }) =>
            domain.storeHocuspocusDocument(documentName, document),
        }),
      );
      return domain;
    }
    function boundCollab() {
      const domain = createCollabDomain({
        db,
        workProjectionMutation: createTestWorkProjectionMutation(db),
        workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
        documentAccess: createDrizzleDocumentAccess(db),
      });
      const hocuspocus = new Hocuspocus({
        yDocOptions: { gc: false, gcFilter: () => true },
        onStoreDocument: ({ documentName, document }) =>
          domain.storeHocuspocusDocument(documentName, document),
      });
      domain.bindHocuspocus(hocuspocus);
      return { domain, hocuspocus };
    }
    it("converges project, Writer, manuscript and unassigned sources without a Work or thread", async () => {
      const repository = createDrizzleProjectBootstrapRepository({ db, documents: collab() });
      const first = await repository.ensureDefaultBootstrap(USER_ID as never);
      const second = await repository.ensureDefaultBootstrap(USER_ID as never);
      expect(second).toEqual(first);
      expect(Object.keys(first).sort()).toEqual([
        "agentDefinitionId",
        "documentId",
        "manuscriptSourceId",
        "projectId",
        "uri",
      ]);
      const [sources, workRows, threadRows, agents, docs] = await Promise.all([
        db
          .select({ slug: schema.contextSources.slug, workId: schema.contextSources.workId })
          .from(schema.contextSources)
          .where(eq(schema.contextSources.projectId, first.projectId)),
        db.select().from(schema.works).where(eq(schema.works.projectId, first.projectId)),
        db.select().from(schema.threads).where(eq(schema.threads.projectId, first.projectId)),
        db
          .select()
          .from(schema.agentDefinitions)
          .where(eq(schema.agentDefinitions.projectId, first.projectId)),
        db.select().from(schema.documents).where(eq(schema.documents.id, first.documentId)),
      ]);
      expect(sources).toEqual(
        expect.arrayContaining([
          { slug: "manuscript", workId: null },
          { slug: "scratch", workId: null },
          { slug: "uploads", workId: null },
        ]),
      );
      expect(workRows).toEqual([]);
      expect(threadRows).toEqual([]);
      expect(agents).toHaveLength(1);
      expect(docs).toHaveLength(1);
    });

    it("rolls project source provisioning back with its ambient transaction", async () => {
      const projectId = crypto.randomUUID();
      await db.insert(schema.projects).values({
        id: projectId,
        userId: USER_ID,
        name: "Ambient source",
        slug: `ambient-${projectId}`,
      });
      const store = createProjectContextDocumentStore(db, projectId, "scratch", USER_ID);
      await expect(
        runInDrizzleTransaction(db, () =>
          store.transaction(async () => {
            await store.createFolder(null, "rolled-back");
            throw new Error("rollback");
          }),
        ),
      ).rejects.toThrow("rollback");
      await expect(
        db
          .select()
          .from(schema.contextSources)
          .where(eq(schema.contextSources.projectId, projectId)),
      ).resolves.toEqual([]);
      await expect(store.createFolder(null, "retry")).resolves.toBeDefined();
    });

    it("preserves writer content across repeated initialize-only bootstrap", async () => {
      const documents = collab();
      const repository = createDrizzleProjectBootstrapRepository({ db, documents });
      const first = await repository.ensureDefaultBootstrap(USER_ID as never);
      await documents.writeDocument({
        documentId: first.documentId,
        markdown: "Writer content\n",
        origin: { type: "user", actorUserId: USER_ID as never },
      });
      const checkpointsBefore = await db
        .select({ id: schema.documentYjsCheckpoints.id })
        .from(schema.documentYjsCheckpoints)
        .where(eq(schema.documentYjsCheckpoints.documentId, first.documentId));

      await expect(repository.ensureDefaultBootstrap(USER_ID as never)).resolves.toEqual(first);
      await expect(documents.readAsMarkdown(first.documentId)).resolves.toEqual({
        ok: true,
        value: "Writer content\n",
      });
      await expect(
        db
          .select({ id: schema.documentYjsCheckpoints.id })
          .from(schema.documentYjsCheckpoints)
          .where(eq(schema.documentYjsCheckpoints.documentId, first.documentId)),
      ).resolves.toHaveLength(checkpointsBefore.length);
    });

    it("rolls back interrupted materialization and provisions cleanly on retry", async () => {
      const { domain, hocuspocus } = boundCollab();
      let interruptedDocumentId: string | undefined;
      const interrupted = createDrizzleProjectBootstrapRepository({
        db,
        documents: {
          ...domain,
          createDocumentAtomically(input) {
            interruptedDocumentId = input.documentId;
            return domain.createDocumentAtomically({
              ...input,
              async initializeContent() {
                await input.initializeContent();
                throw new Error("simulated interruption");
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
      expect(hocuspocus.documents.has(interruptedDocumentId as string)).toBe(false);
      const repaired = await createDrizzleProjectBootstrapRepository({
        db,
        documents: domain,
      }).ensureDefaultBootstrap(USER_ID as never);
      await expect(domain.readAsMarkdown(repaired.documentId)).resolves.toEqual({
        ok: true,
        value: "# Chapter 1\n",
      });
    });

    it("repairs manifest membership without replacing writer content", async () => {
      const documents = collab();
      const repository = createDrizzleProjectBootstrapRepository({ db, documents });
      const first = await repository.ensureDefaultBootstrap(USER_ID as never);
      await documents.writeDocument({
        documentId: first.documentId,
        markdown: "Durable writer draft\n",
        origin: { type: "user", actorUserId: USER_ID as never },
      });
      await documents.recordManifestDocumentDeleted(first.documentId, {
        projectId: first.projectId,
      });
      await repository.ensureDefaultBootstrap(USER_ID as never);
      await expect(
        documents.resolveManifestMembership({ projectId: first.projectId }),
      ).resolves.toMatchObject({ members: [first.documentId] });
      await expect(documents.readAsMarkdown(first.documentId)).resolves.toEqual({
        ok: true,
        value: "Durable writer draft\n",
      });
    });

    it("converges a warm empty Hocuspocus room with the committed seed", async () => {
      const { domain, hocuspocus } = boundCollab();
      let warmConnection: Awaited<ReturnType<typeof hocuspocus.openDirectConnection>> | undefined;
      const bootstrap = await createDrizzleProjectBootstrapRepository({
        db,
        documents: {
          ...domain,
          async seedFromMarkdown(documentId, markdown, origin) {
            warmConnection = await hocuspocus.openDirectConnection(documentId, {
              origin: { type: "system", reason: "bootstrap-race" },
            });
            return domain.seedFromMarkdown(documentId, markdown, origin);
          },
        },
      }).ensureDefaultBootstrap(USER_ID as never);
      await expect(domain.readAsMarkdown(bootstrap.documentId)).resolves.toEqual({
        ok: true,
        value: "# Chapter 1\n",
      });
      await warmConnection?.disconnect();
      await expect(collab().readAsMarkdown(bootstrap.documentId)).resolves.toEqual({
        ok: true,
        value: "# Chapter 1\n",
      });
    });
  });
