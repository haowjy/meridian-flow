/** Adapter-contract tests for the Drizzle DraftStore against local Postgres. */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, it } from "vitest";
import {
  DRAFT_STORE_CONTRACT_IDS,
  runDraftStoreContract,
} from "../../__conformance__/draft-store-contract.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = DRAFT_STORE_CONTRACT_IDS.userId;
const PROJECT_ID = "00000000-0000-4000-8000-000000000402";
const CONTEXT_SOURCE_ID = "00000000-0000-4000-8000-000000000403";
const WORK_ID = DRAFT_STORE_CONTRACT_IDS.workId;
const DOC_ID = DRAFT_STORE_CONTRACT_IDS.docId;
const DOC_B_ID = DRAFT_STORE_CONTRACT_IDS.docBId;
const THREAD_ID = DRAFT_STORE_CONTRACT_IDS.threadId;
const PEER_THREAD_ID = DRAFT_STORE_CONTRACT_IDS.peerThreadId;
const TURN_A = DRAFT_STORE_CONTRACT_IDS.turnA;
const TURN_B = DRAFT_STORE_CONTRACT_IDS.turnB;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle draft store (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("drizzle draft store adapter contract (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const dbSchema = await import("@meridian/database/schema");
    const {
      agentEditMutations,
      agentEditSyncState,
      agentEditWidCounters,
      contextSources,
      documentYjsDrafts,
      documentYjsDraftUpdates,
      documentYjsReversals,
      documents,
      folders,
      projects,
      threadWorks,
      threads,
      turns,
      works,
      users,
    } = dbSchema;
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleDraftStore } = await import("../drizzle-drafts.js");

    const db = createDb(DATABASE_URL, { max: 4 });
    const store = createDrizzleDraftStore(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [
        documentYjsDraftUpdates,
        documentYjsDrafts,
        agentEditSyncState,
        agentEditMutations,
        agentEditWidCounters,
        documentYjsReversals,
        turns,
        threadWorks,
        threads,
        documents,
        folders,
        contextSources,
        works,
        projects,
        users,
      ]);
      await db.insert(users).values(conformanceUserValues(USER_ID, "drizzle-drafts"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Draft Project",
        slug: "draft-project",
      });
      await db.insert(works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Draft Work",
      });
      await db.insert(contextSources).values({
        id: CONTEXT_SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Draft Source",
        slug: "draft-source",
        scope: "project",
      });
      await db.insert(documents).values([
        {
          id: DOC_ID,
          contextSourceId: CONTEXT_SOURCE_ID,
          name: "chapter",
          extension: "md",
          fileType: "markdown",
        },
        {
          id: DOC_B_ID,
          contextSourceId: CONTEXT_SOURCE_ID,
          name: "chapter-b",
          extension: "md",
          fileType: "markdown",
        },
      ]);
      await db.insert(threads).values([
        {
          id: THREAD_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: "Draft Thread",
          kind: "primary",
          status: "active",
        },
        {
          id: PEER_THREAD_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: "Peer Draft Thread",
          kind: "primary",
          status: "active",
        },
      ]);
      await db.insert(threadWorks).values([
        {
          threadId: THREAD_ID,
          workId: WORK_ID,
          projectId: PROJECT_ID,
          isPrimary: true,
        },
        {
          threadId: PEER_THREAD_ID,
          workId: WORK_ID,
          projectId: PROJECT_ID,
          isPrimary: true,
        },
      ]);
      await db.insert(turns).values([
        { id: TURN_A, threadId: THREAD_ID, role: "assistant", status: "complete" },
        {
          id: TURN_B,
          threadId: THREAD_ID,
          parentTurnId: TURN_A,
          role: "assistant",
          status: "complete",
        },
      ]);
    });

    afterAll(async () => {
      await db.$client.end();
    });

    runDraftStoreContract(() => ({
      store,
      expireAcceptClaim: async (draftId) => {
        await db
          .update(documentYjsDrafts)
          .set({ claimedAt: sql`now() - interval '11 minutes'` })
          .where(eq(documentYjsDrafts.id, draftId));
      },
      seedDraftScopedState: async (draftId) => {
        await db.insert(agentEditSyncState).values({
          documentId: DOC_ID as never,
          threadId: THREAD_ID as never,
          scopeId: draftId,
          stateVector: Buffer.from([]),
          syncedSnapshot: Buffer.from([]),
          committedSnapshot: Buffer.from([]),
        });
        await db.insert(agentEditWidCounters).values({
          documentId: DOC_ID as never,
          threadId: THREAD_ID as never,
          scopeId: draftId,
          nextWid: 2,
        });
        await db.insert(agentEditMutations).values({
          wId: 1,
          documentId: DOC_ID as never,
          threadId: THREAD_ID as never,
          scopeId: draftId,
          turnId: TURN_A as never,
          writeId: "w1",
          status: "active",
          createdSeq: 1,
        });
        await db.insert(documentYjsReversals).values({
          documentId: DOC_ID as never,
          threadId: THREAD_ID as never,
          scopeId: draftId,
          turnId: TURN_A as never,
          writeId: "w1",
          status: "active",
          undoUpdateSeq: 2,
        });
        return countDraftScopedState(draftId);
      },
      countDraftScopedState,
    }));

    async function countDraftScopedState(draftId: string): Promise<number> {
      const scope = and(
        eq(agentEditSyncState.documentId, DOC_ID as never),
        eq(agentEditSyncState.scopeId, draftId),
      );
      const [syncState] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(agentEditSyncState)
        .where(scope);
      const [widCounters] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(agentEditWidCounters)
        .where(
          and(
            eq(agentEditWidCounters.documentId, DOC_ID as never),
            eq(agentEditWidCounters.scopeId, draftId),
          ),
        );
      const [mutations] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(agentEditMutations)
        .where(
          and(
            eq(agentEditMutations.documentId, DOC_ID as never),
            eq(agentEditMutations.scopeId, draftId),
          ),
        );
      const [reversals] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(documentYjsReversals)
        .where(
          and(
            eq(documentYjsReversals.documentId, DOC_ID as never),
            eq(documentYjsReversals.scopeId, draftId),
          ),
        );
      return (
        (syncState?.count ?? 0) +
        (widCounters?.count ?? 0) +
        (mutations?.count ?? 0) +
        (reversals?.count ?? 0)
      );
    }
  });
}
