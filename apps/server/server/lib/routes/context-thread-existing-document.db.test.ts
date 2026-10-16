/** Consolidated test contracts; each block retains its original fixture scope. */

import { randomUUID } from "node:crypto";
import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import { eq } from "drizzle-orm";
import { describe as __mergedSuite, afterAll, afterEach, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
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
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";

__mergedSuite("context-thread-existing-document.db.test.ts", () => {
  // Merged from apps/server/server/lib/routes/context-thread-existing-document.db.test.ts.
  const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

  const DATABASE_URL = process.env.DATABASE_URL;

  /** A deadlock shows up as a hang; fail fast and name the call instead. */
  function settlesWithin<T>(label: string, promise: Promise<T>, ms = 8000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle in ${ms}ms`)), ms);
      }),
    ]);
  }

  if (!RUN_DB_TESTS || !DATABASE_URL) {
    __mergedSuite.skip("thread writes onto existing documents (postgres)", () => {});
  } else {
    __mergedSuite("thread writes onto existing documents (postgres)", async () => {
      const { createDb } = await import("@meridian/database");
      const schema = await import("@meridian/database/schema");
      const { conformanceUserValues } = await import(
        "@meridian/database/__test-support__/db-fixtures"
      );
      const { contextPortForThread, resolveThreadContext } = await import(
        "../../domains/context/context-port-resolution.js"
      );
      const { DOCUMENT_RUNTIME_RESET_TABLES, deleteDrizzleRows } = await import(
        "../../test-support/drizzle-reset.js"
      );
      const { bindEditAgent, useComposedRuntimes } = await import(
        "../../test-support/composed-runtime.js"
      );
      const { writeThreadContextDocument } = await import("../thread-context-route.js");
      const USER_ID = "00000000-0000-4000-8000-000000000b01";
      const PROJECT_ID = "00000000-0000-4000-8000-000000000b02";
      const NO_WORK_ID = "00000000-0000-4000-8000-000000000b03";
      const THREAD_ID = "00000000-0000-4000-8000-000000000b04";
      const TURN_ID = "00000000-0000-4000-8000-000000000b05";
      const DIRECT_WORK_ID = "00000000-0000-4000-8000-000000000b06";
      const DRAFT_WORK_ID = "00000000-0000-4000-8000-000000000b07";
      const db = createDb(DATABASE_URL, { max: 6 });
      const runtimes = useComposedRuntimes(() => db);
      /** The production app; the thread resolves from its rows, as a request would. */
      async function createFixture() {
        const runtime = await runtimes.compose();
        const { app, ports } = runtime;
        const routeDeps = {
          contextPorts: app.contextPorts,
          fileAccess: app.fileAccess,
          threads: app.threadRepos.threads,
          threadWorks: app.threadRepos.threadWorks,
          works: app.workRepo,
          workAuthorityResolver: app.workAuthorityResolver,
        };
        // Any model tool through the executor, outside a reply.
        const callTool = async (name: string, input: Record<string, unknown>) => {
          await bindEditAgent(runtime, THREAD_ID);
          return app.toolExecutor.executeTool(
            { id: randomUUID(), name, arguments: input },
            { threadId: THREAD_ID, turnId: TURN_ID, agentSlug: null },
          );
        };
        const callWrite = (input: Record<string, unknown>) => callTool("write", input);
        return {
          collab: ports.documentSync,
          contextPorts: app.contextPorts,
          routeDeps,
          callWrite,
          callTool,
        };
      }
      type Fixture = Awaited<ReturnType<typeof createFixture>>;
      const succeeded = { result: { status: "success" } };
      beforeEach(async () => {
        await deleteDrizzleRows(db, DOCUMENT_RUNTIME_RESET_TABLES);
        await db.insert(schema.users).values(conformanceUserValues(USER_ID, "thread-existing"));
        await db
          .insert(schema.projects)
          .values({ id: PROJECT_ID, userId: USER_ID, name: "Project", slug: "thread-existing" });
        await db.insert(schema.contextSources).values({
          projectId: PROJECT_ID,
          name: "Manuscript",
          slug: "manuscript",
          scope: "project",
          isPrimary: true,
        });
        await db.insert(schema.works).values({
          id: NO_WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "No Work",
          isNoWork: true,
        });
        await db.insert(schema.works).values([
          {
            id: DIRECT_WORK_ID,
            projectId: PROJECT_ID,
            createdByUserId: USER_ID,
            name: "Direct",
            slug: "direct",
          },
          {
            id: DRAFT_WORK_ID,
            projectId: PROJECT_ID,
            createdByUserId: USER_ID,
            name: "Draft",
            slug: "draft",
          },
        ]);
        await db.insert(schema.threads).values({
          rootThreadId: THREAD_ID,
          id: THREAD_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: "Thread",
          kind: "primary",
          status: "idle",
        });
        await db.insert(schema.turns).values({
          id: TURN_ID,
          threadId: THREAD_ID,
          position: 1,
          role: "assistant",
          origin: "assistant",
          status: "complete",
        });
        // A write called outside a reply records its turn as the authoring response.
        await db.insert(schema.modelResponses).values({
          id: TURN_ID,
          turnId: TURN_ID,
          sequence: 1,
          provider: "fixture",
          model: "fixture",
          requestMessageCount: 1,
          predictedCacheState: "cold",
          predictedCacheReason: "facts_unavailable",
        });
        await db.insert(schema.threadWorks).values({
          threadId: THREAD_ID,
          workId: NO_WORK_ID,
          projectId: PROJECT_ID,
          isPrimary: true,
        });
      });
      afterAll(async () => {
        await db.close();
      });
      /** The writer's document: people write live (D20), so it seeds through a live port. */
      async function seedExisting(fixture: Fixture, path: string) {
        const resolution = await resolveThreadContext(fixture.routeDeps, THREAD_ID);
        if (!resolution) throw new Error("thread did not resolve");
        const port = contextPortForThread(fixture.contextPorts, resolution, { liveWrites: true });
        const created = await settlesWithin(
          `seed ${path}`,
          port.write(`manuscript://${path}`, `Existing ${path}.\n`),
        );
        if (!created.ok || !created.value.documentId) throw new Error(`could not seed ${path}`);
        await fixture.collab.drainHocuspocusPersistence();
        return created.value.documentId;
      }
      async function bindThread(workId: string) {
        await db
          .update(schema.threadWorks)
          .set({ workId })
          .where(eq(schema.threadWorks.threadId, THREAD_ID));
      }
      // A writer overwrite stays live even when the thread drafts model writes.
      it("overwrites an existing document from a draft-mode thread at once", async () => {
        await bindThread(DRAFT_WORK_ID);
        await db
          .update(schema.threads)
          .set({ aiWriteMode: "draft" })
          .where(eq(schema.threads.id, THREAD_ID));
        const fixture = await createFixture();
        const existingId = await seedExisting(fixture, "target.md");
        const created = await settlesWithin(
          "create overwrite",
          fixture.callWrite({
            command: "create",
            path: "manuscript://target.md",
            content: "Created over.",
            overwrite: true,
          }),
        );
        expect(created).toMatchObject(succeeded);
        await expect(
          settlesWithin(
            "writer route write",
            writeThreadContextDocument(fixture.routeDeps, {
              threadId: THREAD_ID as ThreadId,
              userId: USER_ID as UserId,
              uri: "manuscript://target.md",
              markdown: "Writer replaced this.\n",
            }),
          ),
        ).resolves.toMatchObject({ documentId: existingId });
      });
      it("refuses an unknown Work or scheme in a read as not found", async () => {
        const fixture = await createFixture();
        for (const path of ["scratch://@ghost-arc/backstory.md", "skill://story-review/x.md"]) {
          const read = await fixture.callTool("read", { path });
          expect(read.result).toMatchObject({ status: "document_not_found" });
        }
      });
    });
  }
});

__mergedSuite("context-thread-manifest-lock.db.test.ts", () => {
  // Merged from apps/server/server/lib/routes/context-thread-manifest-lock.db.test.ts.
  const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

  const DATABASE_URL = process.env.DATABASE_URL;

  /** A deadlock shows up as a hang; fail fast and name the call instead. */
  function settlesWithin<T>(label: string, promise: Promise<T>, ms = 8000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle in ${ms}ms`)), ms);
      }),
    ]);
  }

  if (!RUN_DB_TESTS || !DATABASE_URL) {
    __mergedSuite.skip("thread manifest checks and live room release (postgres)", () => {});
  } else {
    __mergedSuite("thread manifest checks and live room release (postgres)", async () => {
      const { Hocuspocus } = await import("@hocuspocus/server");
      const { createDb } = await import("@meridian/database");
      const schema = await import("@meridian/database/schema");
      const { conformanceUserValues } = await import(
        "@meridian/database/__test-support__/db-fixtures"
      );
      const { createCollabDomain } = await import("../../domains/collab/composition.js");
      const { createProductionUnifiedContextPortFactory } = await import(
        "../../domains/context/unified-context-port-factory.js"
      );
      const { contextPortForThread, resolveThreadContext } = await import(
        "../../domains/context/context-port-resolution.js"
      );
      const { createDrizzleProjectWorkAuthorityResolver, createDrizzleProjectWorkRepository } =
        await import("../../domains/projects/index.js");
      const { deleteDrizzleRows } = await import("../../test-support/drizzle-reset.js");
      const { currentDrizzleDb, runInDrizzleTransaction, runOutsideDrizzleTransaction } =
        await import("../../shared/drizzle-transaction.js");
      const { lockDocumentMutation } = await import("../../shared/document-mutation-lock.js");
      const USER_ID = "00000000-0000-4000-8000-000000000b01";
      const PROJECT_ID = "00000000-0000-4000-8000-000000000b02";
      const NO_WORK_ID = "00000000-0000-4000-8000-000000000b03";
      const THREAD_ID = "00000000-0000-4000-8000-000000000b04";
      const TURN_ID = "00000000-0000-4000-8000-000000000b05";
      const db = createDb(DATABASE_URL, { max: 6 });
      const fixtures: Array<{
        collab: ReturnType<typeof createCollabDomain>;
        hocuspocus: InstanceType<typeof Hocuspocus>;
      }> = [];
      function createFixture() {
        const collab = createCollabDomain({
          ...testLinkDeps(db),
          fileAccess: createAllowAllFileAccess(),
          db,
          workProjectionMutation: createTestWorkProjectionMutation(db),
          catalogMutations: createDrizzleContextCatalog(db),
        });
        const hocuspocus = new Hocuspocus({
          yDocOptions: { gc: false, gcFilter: () => true },
          async onLoadDocument({ documentName, document }) {
            const state = await collab.loadHocuspocusDocument(documentName, document);
            if (state) Y.applyUpdate(document, state);
          },
          onStoreDocument: ({ documentName, document }) =>
            collab.storeHocuspocusDocument(documentName, document),
        });
        collab.bindHocuspocus(hocuspocus);
        fixtures.push({ collab, hocuspocus });
        const contextPorts = createProductionUnifiedContextPortFactory({
          links: createTestDocumentLinkScopes(db),
          db,
          documentSync: collab,
          drafts: collab.drafts,
        });
        const routeDeps = {
          contextPorts,
          threads: {
            findById: async (id: string) =>
              id === THREAD_ID
                ? ({ id: THREAD_ID, projectId: PROJECT_ID, userId: USER_ID } as never)
                : null,
          },
          threadWorks: {
            findPrimary: async (threadId: string) =>
              threadId === THREAD_ID ? ({ threadId, workId: NO_WORK_ID } as never) : null,
          },
          works: createDrizzleProjectWorkRepository({
            lineageScratch: createDrizzleLineageScratchLifecycle(db),
            db,
            fileAccessChanges: createLocalFileAccessChanges(),
            projectionMutation: createTestWorkProjectionMutation(db),
          }),
          workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
        };
        return { collab, hocuspocus, contextPorts, routeDeps };
      }
      async function threadPort(fixture: ReturnType<typeof createFixture>) {
        const resolution = await resolveThreadContext(fixture.routeDeps, THREAD_ID);
        if (!resolution) throw new Error("thread did not resolve");
        return contextPortForThread(fixture.contextPorts, resolution, { responseId: null });
      }
      beforeEach(async () => {
        await deleteDrizzleRows(db, [
          schema.branchPushOutboxUpdates,
          schema.branchPushSettlementOutbox,
          schema.branchPushSettlementBatches,
          schema.changeTrailDeliveryOutbox,
          schema.changeTrailDocumentDetails,
          schema.changeTrailDocumentOccurrences,
          schema.changeTrailShells,
          schema.pendingNotices,
          schema.agentEditWidCounters,
          schema.branchWriteJournal,
          schema.pushLineage,
          schema.documentBranches,
          schema.documentYjsCheckpoints,
          schema.documentYjsHeads,
          schema.documentYjsUpdates,
          schema.modelResponses,
          schema.threadWorks,
          schema.turns,
          schema.threads,
          schema.folders,
          schema.documents,
          schema.contextSources,
          schema.works,
          schema.projects,
          schema.users,
        ]);
        await db.insert(schema.users).values(conformanceUserValues(USER_ID, "thread-existing"));
        await db
          .insert(schema.projects)
          .values({ id: PROJECT_ID, userId: USER_ID, name: "Project", slug: "thread-existing" });
        await db.insert(schema.contextSources).values({
          projectId: PROJECT_ID,
          name: "Manuscript",
          slug: "manuscript",
          scope: "project",
          isPrimary: true,
        });
        await db.insert(schema.works).values({
          id: NO_WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "No Work",
          isNoWork: true,
        });
        await db.insert(schema.threads).values({
          rootThreadId: THREAD_ID,
          id: THREAD_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: "Thread",
          kind: "primary",
          status: "idle",
        });
        await db.insert(schema.turns).values({
          id: TURN_ID,
          threadId: THREAD_ID,
          position: 1,
          role: "assistant",
          origin: "assistant",
          status: "complete",
        });
        // A write called outside a reply records its turn as the authoring response.
        await db.insert(schema.modelResponses).values({
          id: TURN_ID,
          turnId: TURN_ID,
          sequence: 1,
          provider: "fixture",
          model: "fixture",
          requestMessageCount: 1,
          predictedCacheState: "cold",
          predictedCacheReason: "facts_unavailable",
        });
        await db.insert(schema.threadWorks).values({
          threadId: THREAD_ID,
          workId: NO_WORK_ID,
          projectId: PROJECT_ID,
          isPrimary: true,
        });
      });
      afterEach(async () => {
        for (const { collab, hocuspocus } of fixtures.splice(0)) {
          hocuspocus.closeConnections();
          hocuspocus.flushPendingStores();
          await collab.drainHocuspocusPersistence();
        }
      });
      afterAll(async () => {
        await db.close();
      });
      async function seedExisting(fixture: ReturnType<typeof createFixture>, path: string) {
        const port = await threadPort(fixture);
        const created = await settlesWithin(
          `seed ${path}`,
          port.write(`manuscript://${path}`, `Existing ${path}.\n`),
        );
        if (!created.ok || !created.value.documentId) throw new Error(`could not seed ${path}`);
        await fixture.collab.drainHocuspocusPersistence();
        return created.value.documentId;
      }
      it("releases a live room outside a transaction that holds that document's lock", async () => {
        const fixture = createFixture();
        const documentId = await seedExisting(fixture, "held.md");
        // A live snapshot taken outside its caller's transaction (as thread-peer
        // pulls do) stores the room on release. That store must not wait on the
        // lock the caller still holds, or the caller waits on itself.
        await settlesWithin(
          "release under the caller's lock",
          runInDrizzleTransaction(db, async () => {
            await lockDocumentMutation(currentDrizzleDb(db) as never, documentId);
            await runOutsideDrizzleTransaction(async () => {
              const connection = await fixture.hocuspocus.openDirectConnection(documentId, {});
              await connection.transact((doc) => {
                doc.getText("probe").insert(0, "x");
              });
              await connection.disconnect();
            });
          }),
        );
        await settlesWithin("checkpoint after commit", fixture.collab.drainHocuspocusPersistence());
      });
    });
  }
});
