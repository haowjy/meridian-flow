/** Consolidated test contracts; each block retains its original fixture scope. */

import { describe as __mergedSuite, afterAll, beforeEach, expect, it } from "vitest";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";
import { testLinkDeps } from "../collab/test-support/document-link-scopes.js";
import { createDrizzleContextCatalog } from "../context/adapters/context-catalog.js";
import { createAllowAllFileAccess } from "../file-policy/index.js";
import { createProjectBootstrapRepositoryForTest as createDrizzleProjectBootstrapRepository } from "./test-support/project-repository.js";

__mergedSuite("project-bootstrap.db.test.ts", () => {
  // Merged from apps/server/server/domains/projects/project-bootstrap.db.test.ts.
  const RUN = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

  const DATABASE_URL = process.env.DATABASE_URL;

  if (!RUN || !DATABASE_URL) __mergedSuite.skip("project bootstrap (postgres)", () => {});
  else
    __mergedSuite("project bootstrap (postgres)", async () => {
      const { Hocuspocus } = await import("@hocuspocus/server");
      const schema = await import("@meridian/database/schema");
      const { conformanceUserValues } = await import(
        "@meridian/database/__test-support__/db-fixtures"
      );
      const { eq } = await import("drizzle-orm");
      const { createCollabDomain } = await import("../collab/composition.js");
      const { useRollbackTestDatabase, deleteDrizzleRows } = await import(
        "../../test-support/drizzle-reset.js"
      );
      const { createProjectContextDocumentStore } = await import(
        "../context/context-source-provisioning.js"
      );
      const { runInDrizzleTransaction } = await import("../../shared/drizzle-transaction.js");
      const USER_ID = "00000000-0000-4000-8000-000000000751";
      const database = useRollbackTestDatabase(DATABASE_URL, {
        prepareSuite: (db) => deleteDrizzleRows(db, [schema.users]),
      });
      let db = database.current;
      beforeEach(async () => {
        db = database.current;
        await db.insert(schema.users).values(conformanceUserValues(USER_ID, "no-work-bootstrap"));
      });
      function collab() {
        const domain = createCollabDomain({
          ...testLinkDeps(db),
          fileAccess: createAllowAllFileAccess(),
          db,
          workProjectionMutation: createTestWorkProjectionMutation(db),
          catalogMutations: createDrizzleContextCatalog(db),
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
          ...testLinkDeps(db),
          fileAccess: createAllowAllFileAccess(),
          db,
          workProjectionMutation: createTestWorkProjectionMutation(db),
          catalogMutations: createDrizzleContextCatalog(db),
        });
        const hocuspocus = new Hocuspocus({
          yDocOptions: { gc: false, gcFilter: () => true },
          onStoreDocument: ({ documentName, document }) =>
            domain.storeHocuspocusDocument(documentName, document),
        });
        domain.bindHocuspocus(hocuspocus);
        return { domain, hocuspocus };
      }
      it("converges project, manuscript, locked No Work, and No Work uploads without a thread", async () => {
        const repository = createDrizzleProjectBootstrapRepository({
          db,
          documents: collab(),
        });
        const first = await repository.ensureDefaultBootstrap(USER_ID as never);
        const second = await repository.ensureDefaultBootstrap(USER_ID as never);
        expect(second).toEqual(first);
        expect(
          await db
            .select({ slug: schema.projects.slug })
            .from(schema.projects)
            .where(eq(schema.projects.id, first.projectId)),
        ).toEqual([{ slug: "my-serial" }]);
        expect(Object.keys(first).sort()).toEqual([
          "documentId",
          "manuscriptSourceId",
          "projectId",
          "uri",
        ]);
        const [manuscript, workRows, threadRows, docs] = await Promise.all([
          db
            .select({
              slug: schema.contextSources.slug,
              workId: schema.contextSources.workId,
              scope: schema.contextSources.scope,
            })
            .from(schema.contextSources)
            .where(eq(schema.contextSources.projectId, first.projectId)),
          db.select().from(schema.works).where(eq(schema.works.projectId, first.projectId)),
          db.select().from(schema.threads).where(eq(schema.threads.projectId, first.projectId)),
          db.select().from(schema.documents).where(eq(schema.documents.id, first.documentId)),
        ]);
        expect(workRows).toEqual([
          expect.objectContaining({
            isNoWork: true,
            slug: null,
            name: "No Work",
            status: null,
          }),
        ]);
        const noWorkId = workRows[0]?.id;
        const workSources = await db
          .select({
            slug: schema.contextSources.slug,
            workId: schema.contextSources.workId,
            scope: schema.contextSources.scope,
            projectId: schema.contextSources.projectId,
          })
          .from(schema.contextSources)
          .where(eq(schema.contextSources.workId, noWorkId));
        expect(manuscript).toEqual([{ slug: "manuscript", workId: null, scope: "project" }]);
        expect(workSources).toEqual(
          expect.arrayContaining([
            { slug: "uploads", workId: noWorkId, scope: "work", projectId: null },
          ]),
        );
        expect(workSources).toHaveLength(1);
        expect(threadRows).toEqual([]);
        expect(docs).toHaveLength(1);
        expect(docs[0]).toMatchObject({
          name: "Chapter 1",
          extension: "",
          fileType: "markdown",
        });
        expect(first.uri).toBe("manuscript://Chapter 1");
      });
      it("rolls project source provisioning back with its ambient transaction", async () => {
        const projectId = crypto.randomUUID();
        await db.insert(schema.projects).values({
          id: projectId,
          userId: USER_ID,
          name: "Ambient source",
          slug: `ambient-${projectId}`,
        });
        const store = createProjectContextDocumentStore(db, projectId, "manuscript", USER_ID);
        await expect(
          runInDrizzleTransaction(db, () =>
            store.transaction(async () => {
              await store.ensureFolderPath(["rolled-back"]);
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
        await expect(store.ensureFolderPath(["retry"])).resolves.toBeDefined();
      });
      it("rolls back interrupted materialization and provisions cleanly on retry", async () => {
        const { domain, hocuspocus } = boundCollab();
        let interruptedDocumentId: string | undefined;
        const interrupted = createDrizzleProjectBootstrapRepository({
          db,
          documents: {
            ...domain,
            createDocumentAtomically(input) {
              return domain.createDocumentAtomically({
                ...input,
                async persistIdentity() {
                  const documentId = await input.persistIdentity();
                  interruptedDocumentId = documentId ?? undefined;
                  return documentId;
                },
                async initializeContent(documentId) {
                  await input.initializeContent(documentId);
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
});

__mergedSuite("project-bootstrap-readiness.db.test.ts", () => {
  // Merged from apps/server/server/domains/projects/project-bootstrap-readiness.db.test.ts.
  const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

  const DATABASE_URL = process.env.DATABASE_URL;

  if (!RUN_DB_TESTS || !DATABASE_URL) {
    __mergedSuite.skip("project bootstrap readiness (postgres)", () => {});
  } else {
    __mergedSuite("project bootstrap readiness (postgres)", async () => {
      const { Hocuspocus } = await import("@hocuspocus/server");
      const { createDb } = await import("@meridian/database");
      const schema = await import("@meridian/database/schema");
      const { conformanceUserValues } = await import(
        "@meridian/database/__test-support__/db-fixtures"
      );
      const { createCollabDomain } = await import("../collab/composition.js");
      const { deleteDrizzleRows } = await import("../../test-support/drizzle-reset.js");
      const { default: postgres } = await import("postgres");
      const USER_ID = "00000000-0000-4000-8000-000000000358";
      const db = createDb(DATABASE_URL, { max: 4 });
      const lockClient = postgres(DATABASE_URL, { max: 1 });
      const probeClient = postgres(DATABASE_URL, { max: 1 });
      beforeEach(async () => {
        await deleteDrizzleRows(db, [schema.users]);
        await db.insert(schema.users).values(conformanceUserValues(USER_ID, "bootstrap-readiness"));
      });
      afterAll(async () => {
        await db.$client.end();
        await lockClient.end();
        await probeClient.end();
      });
      function createBoundCollab() {
        const collab = createCollabDomain({
          ...testLinkDeps(db),
          fileAccess: createAllowAllFileAccess(),
          db,
          workProjectionMutation: createTestWorkProjectionMutation(db),
          catalogMutations: createDrizzleContextCatalog(db),
        });
        const hocuspocus = new Hocuspocus({
          yDocOptions: { gc: false, gcFilter: () => true },
          onStoreDocument: ({ documentName, document }) =>
            collab.storeHocuspocusDocument(documentName, document),
        });
        collab.bindHocuspocus(hocuspocus);
        return collab;
      }
      it("provisions the cold path, then stays lock-free and out of collab when ready", async () => {
        const collab = createBoundCollab();
        let seedCalls = 0;
        const coldRepository = createDrizzleProjectBootstrapRepository({
          db,
          documents: {
            ...collab,
            async seedFromMarkdown(...args: Parameters<typeof collab.seedFromMarkdown>) {
              seedCalls += 1;
              return collab.seedFromMarkdown(...args);
            },
          },
        });
        await expect(coldRepository.ensureDefaultBootstrapReady(USER_ID as never)).resolves.toBe(
          true,
        );
        expect(seedCalls).toBe(1);
        await expect(
          Promise.all([
            db.select({ id: schema.projects.id }).from(schema.projects),
            db.select({ id: schema.works.id }).from(schema.works),
            db.select({ id: schema.contextSources.id }).from(schema.contextSources),
            db.select({ id: schema.documents.id }).from(schema.documents),
            db.select({ id: schema.threads.id }).from(schema.threads),
          ]).then((rows) => rows.map((row) => row.length)),
        ).resolves.toEqual([1, 1, 2, 1, 0]);
        const [project] = await db
          .select({ ready: schema.projects.defaultBootstrapReady })
          .from(schema.projects);
        expect(project?.ready).toBe(true);
        let lockHeld = false;
        let probeLockAcquired = false;
        let warmCall: Promise<boolean> | undefined;
        try {
          await lockClient`
          select pg_advisory_lock(hashtextextended(${USER_ID}, 0::bigint))
        `;
          lockHeld = true;
          const [competingLock] = await probeClient`
          select pg_try_advisory_lock(hashtextextended(${USER_ID}, 0::bigint)) as acquired
        `;
          probeLockAcquired = competingLock?.acquired === true;
          expect(competingLock?.acquired).toBe(false);
          warmCall = coldRepository.ensureDefaultBootstrapReady(USER_ID as never);
          let watchdog: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              warmCall,
              new Promise<never>((_, reject) => {
                watchdog = setTimeout(
                  () => reject(new Error("Ready bootstrap waited on advisory lock")),
                  10000,
                );
              }),
            ]);
          } finally {
            if (watchdog) clearTimeout(watchdog);
          }
          await expect(warmCall).resolves.toBe(true);
          expect(seedCalls).toBe(1);
        } finally {
          try {
            if (probeLockAcquired) {
              await probeClient`
              select pg_advisory_unlock(hashtextextended(${USER_ID}, 0::bigint))
            `;
            }
          } finally {
            try {
              if (lockHeld) {
                await lockClient`
                select pg_advisory_unlock(hashtextextended(${USER_ID}, 0::bigint))
              `;
              }
            } finally {
              // The watchdog bounds the assertion, not the underlying repository call.
              // Drain it after releasing the competing lock before the DB runner resets.
              if (warmCall)
                await warmCall.then(
                  () => undefined,
                  () => undefined,
                );
            }
          }
        }
      });
      it("isolates atomic bootstrap failure and provisions cleanly on a later request", async () => {
        const collab = createBoundCollab();
        const interrupted = createDrizzleProjectBootstrapRepository({
          db,
          documents: {
            ...collab,
            async seedFromMarkdown() {
              throw new Error("transient seed failure");
            },
          },
        });
        await expect(interrupted.ensureDefaultBootstrapReady(USER_ID as never)).resolves.toBe(
          false,
        );
        await expect(db.select().from(schema.projects)).resolves.toHaveLength(0);
        await expect(db.select().from(schema.documents)).resolves.toHaveLength(0);
        const repaired = createDrizzleProjectBootstrapRepository({
          db,
          documents: collab,
        });
        await expect(repaired.ensureDefaultBootstrapReady(USER_ID as never)).resolves.toBe(true);
        const [ready] = await db
          .select({ ready: schema.projects.defaultBootstrapReady })
          .from(schema.projects);
        expect(ready?.ready).toBe(true);
        const [document] = await db.select({ id: schema.documents.id }).from(schema.documents);
        expect(await collab.readAsMarkdown(document?.id as never)).toEqual({
          ok: true,
          value: "# Chapter 1\n",
        });
      });
    });
  }
});
