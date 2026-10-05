/**
 * A thread's list checks manifest membership inside the namespace-locked
 * command transaction; that check must never wait on a lock its own
 * transaction holds. Releasing a live room must never wait on a document lock
 * a caller holds. The model's create onto an existing document is covered by
 * context-thread-existing-document.db.test.ts.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";

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
  describe.skip("thread manifest checks and live room release (postgres)", () => {});
} else {
  describe("thread manifest checks and live room release (postgres)", async () => {
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
    const { createDrizzleDocumentAccess } = await import("../document-access.js");
    const { deleteDrizzleRows } = await import("../../test-support/drizzle-reset.js");
    const { currentDrizzleDb, runInDrizzleTransaction, runOutsideDrizzleTransaction } =
      await import("../../shared/drizzle-transaction.js");
    const { lockDocumentMutation } = await import(
      "../../domains/collab/adapters/drizzle-document-mutation-lock.js"
    );

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
        db,
        workProjectionMutation: createTestWorkProjectionMutation(db),
        workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
        documentAccess: createDrizzleDocumentAccess(db),
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
        db,
        documentSync: collab,
        manifestMembership: collab,
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
          db,
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
        schema.turnTrailWork,
        schema.changeTrailDeliveryOutbox,
        schema.changeTrailDocumentDetails,
        schema.changeTrailDocumentOccurrences,
        schema.changeTrailShells,
        schema.pendingNotices,
        schema.documentYjsReversalOps,
        schema.documentYjsReversals,
        schema.agentEditWidCounters,
        schema.agentEditMutations,
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

    it("lists the manuscript at once", async () => {
      const fixture = createFixture();
      await seedExisting(fixture, "listed.md");
      const port = await threadPort(fixture);

      const listed = await settlesWithin("list", port.list("manuscript://"));
      expect(listed.ok).toBe(true);
      expect(JSON.stringify(listed)).toContain("listed.md");
    });

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
