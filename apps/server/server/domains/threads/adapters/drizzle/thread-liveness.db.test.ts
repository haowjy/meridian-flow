import { createTestDrizzleDelivery } from "../../../runtime/loop/__tests__/test-drizzle-delivery.js";
/**
 * PostgreSQL coverage for R2: the project list and the live state read the
 * running turn from the live run lease, and agree on liveness.
 */

import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-0000000009a1" as UserId;
const PROJECT_ID = "00000000-0000-4000-8000-0000000009a2" as ProjectId;
const THREAD_ID = "00000000-0000-4000-8000-0000000009a3" as ThreadId;
const TURN_ID = "00000000-0000-4000-8000-0000000009a4" as TurnId;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("thread liveness (postgres)", () => {});
} else {
  describe("thread liveness (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleRunClaim } = await import("../../../runtime/index.js");
    const { createThreadRuntimeService } = await import("../../runtime-service.js");
    const { createDrizzleThreadRepository } = await import("./thread-repository.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 6 });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "thread-liveness"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Thread Liveness",
        slug: "thread-liveness",
      });
      await db.insert(schema.threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Chat",
      });
      await db.insert(schema.turns).values({
        id: TURN_ID,
        threadId: THREAD_ID,
        role: "assistant",
        origin: "assistant",
        status: "streaming",
      });
    });

    afterAll(async () => {
      await db.close();
    });

    it("keeps snapshot payload and journal cursors on one committed view", async () => {
      const { createDrizzleRepositoriesForTest } = await import("./repositories.js");
      const { createDrizzleEventJournalReader } = await import("./event-reader.js");
      const { createDrizzleEventJournalWriter } = await import("./event-writer.js");
      const { createThreadEventHub } = await import("../../thread-event-hub.js");
      const { buildThreadSnapshot } = await import("../../thread-snapshot.js");
      const { createNoopEventSink } = await import("../../../observability/index.js");
      const { runInDrizzleTransaction, runOutsideDrizzleTransaction } = await import(
        "../../../../shared/drizzle-transaction.js"
      );
      const repos = createDrizzleRepositoriesForTest(db);
      const writer = createDrizzleEventJournalWriter(db);
      const reader = createDrizzleEventJournalReader(db);
      const hub = createThreadEventHub({
        journalWriter: writer,
        journalReader: reader,
        eventSink: createNoopEventSink(),
      });
      const original = await repos.blocks.create({
        turnId: TURN_ID,
        blockType: "custom",
        sequence: 0,
        content: { version: 1 },
      });
      await writer.appendEvent(THREAD_ID, {
        type: "block.upserted",
        block: { ...original, status: "complete" },
      });
      const readers = {
        read: async () => ({ kind: "asleep" as const }),
        readRunningTurnId: async () => null,
        readMany: async () => new Map(),
        readPending: async () => ({ items: [] }),
      };
      const snapshot = await buildThreadSnapshot(
        {
          ...repos,
          blocks: {
            ...repos.blocks,
            async listByThread(threadId) {
              const blocks = await repos.blocks.listByThread(threadId);
              await runOutsideDrizzleTransaction(() =>
                runInDrizzleTransaction(db, async () => {
                  const updated = await repos.blocks.replaceExisting({
                    ...original,
                    content: { version: 2 },
                  });
                  if (!updated) throw new Error("missing fixture block");
                  await writer.appendEvent(THREAD_ID, {
                    type: "block.updated",
                    block: { ...updated, status: "complete" },
                  });
                }),
              );
              return blocks;
            },
          },
        },
        hub,
        readers,
        THREAD_ID,
      );
      expect(snapshot.turns[0].blocks[0].content).toEqual({ version: 1 });
      expect(snapshot.liveState.resumeAfterSeq).toBe("1999");
      expect(snapshot.nextSeq).toBe("2000");
      const fresh = await buildThreadSnapshot(repos, hub, readers, THREAD_ID);
      expect(fresh.turns[0].blocks[0].content).toEqual({ version: 2 });
      expect(fresh.liveState.resumeAfterSeq).toBe("2999");
    });

    it("reads the running turn from the lease in both the list and live state", async () => {
      const authority = createDrizzleRunClaim(db);
      const repo = createDrizzleThreadRepository(db, { statusReader: authority });
      const runtime = createThreadRuntimeService({
        db,
        statusReader: authority,
        threads: repo,
        readPending: async () => ({ items: [] }),
      });

      const lease = await authority.startExecution(THREAD_ID, "run-1");
      if (!lease) throw new Error("expected the lease to be acquired");
      await createTestDrizzleDelivery(db, { runClaim: authority }).adoptBatch(lease, async () => ({
        value: undefined,
        turnId: TURN_ID,
        messageIds: [],
      }));

      const listed = (await repo.listByProject(PROJECT_ID)).find((row) => row.id === THREAD_ID);
      const live = await runtime.liveState(THREAD_ID, USER_ID);
      expect(listed?.runningTurnId).toBe(TURN_ID);
      expect(live.runningTurnId).toBe(TURN_ID);
      expect(live.status).toEqual({ kind: "awake", phase: "generating", cancelRequested: false });

      await authority.release(lease);

      const afterRelease = (await repo.listByProject(PROJECT_ID)).find(
        (row) => row.id === THREAD_ID,
      );
      const liveAfterRelease = await runtime.liveState(THREAD_ID, USER_ID);
      expect(afterRelease?.runningTurnId).toBeNull();
      expect(liveAfterRelease.runningTurnId).toBeNull();
      expect(liveAfterRelease.status).toEqual({ kind: "asleep" });
    });
  });
}
