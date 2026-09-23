/** Real-Postgres transaction boundary for local journal publication and pg_notify. */
import type { ProjectId, ThreadId, UserId } from "@meridian/contracts/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
const USER_ID = "00000000-0000-4000-8000-000000000b01" as UserId;
const PROJECT_ID = "00000000-0000-4000-8000-000000000b02" as ProjectId;
const THREAD_ID = "00000000-0000-4000-8000-000000000b03" as ThreadId;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("thread event hub transaction publication (postgres)", () => {});
} else {
  describe("thread event hub transaction publication (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { createDrizzleEventJournalReader, createDrizzleEventJournalWriter } = await import(
      "./adapters/drizzle/index.js"
    );
    const { createNoopEventSink } = await import("../observability/index.js");
    const { runAfterDrizzleCommit, runInDrizzleSavepoint, runInDrizzleTransaction } = await import(
      "../../shared/drizzle-transaction.js"
    );
    const { createThreadEventHub } = await import("./thread-event-hub.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 6 });
    const journalWriter = createDrizzleEventJournalWriter(db);
    const journalReader = createDrizzleEventJournalReader(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [
        schema.eventJournal,
        schema.threads,
        schema.projects,
        schema.users,
      ]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "thread-event-hub-tx"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Thread event hub transaction test",
        slug: "thread-event-hub-transaction-test",
      });
      await db.insert(schema.threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Journal publication",
      });
    });

    afterAll(async () => {
      await db.close();
    });

    it("publishes neither locally nor through PostgreSQL for outer/savepoint rollback", async () => {
      const local: bigint[] = [];
      const remote: string[] = [];
      const hub = createThreadEventHub({
        journalWriter,
        journalReader,
        eventSink: createNoopEventSink(),
        scheduleAfterCommit: runAfterDrizzleCommit,
      });
      const unsubscribe = hub.subscribe(THREAD_ID, (entry) => local.push(entry.seq));
      const unlisten = await db.listen("thread_events", (payload) => remote.push(payload));
      const event = {
        type: "subagent.activity" as const,
        rootThreadId: THREAD_ID,
        childThreadId: "child",
        activity: { descendants: [] },
      };

      await expect(
        runInDrizzleTransaction(db, async () => {
          await hub.appendEvent(THREAD_ID, event);
          expect(local).toEqual([]);
          throw new Error("outer rollback");
        }),
      ).rejects.toThrow("outer rollback");

      await runInDrizzleTransaction(db, async () => {
        await expect(
          runInDrizzleSavepoint(db, async () => {
            await hub.appendEvent(THREAD_ID, event);
            throw new Error("savepoint rollback");
          }),
        ).rejects.toThrow("savepoint rollback");
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await journalReader.headSeq(THREAD_ID)).toBe(0n);
      expect(local).toEqual([]);
      expect(remote).toEqual([]);

      unsubscribe();
      await unlisten.unlisten();
    });

    it("publishes a journal event locally and remotely after outer commit", async () => {
      const local: bigint[] = [];
      const remote: string[] = [];
      const hub = createThreadEventHub({
        journalWriter,
        journalReader,
        eventSink: createNoopEventSink(),
        scheduleAfterCommit: runAfterDrizzleCommit,
      });
      const unsubscribe = hub.subscribe(THREAD_ID, (entry) => local.push(entry.seq));
      const unlisten = await db.listen("thread_events", (payload) => remote.push(payload));
      await runInDrizzleTransaction(db, () =>
        hub.appendEvent(THREAD_ID, {
          type: "subagent.activity",
          rootThreadId: THREAD_ID,
          childThreadId: "child",
          activity: { descendants: [] },
        }),
      );

      await waitUntil(() => local.length === 1 && remote.length === 1);
      expect(local).toEqual([1_000n]);
      expect(remote).toEqual([`${THREAD_ID}:1`]);

      unsubscribe();
      await unlisten.unlisten();
    });

    async function waitUntil(predicate: () => boolean): Promise<void> {
      const deadline = Date.now() + 1_000;
      while (!predicate() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(predicate()).toBe(true);
    }
  });
}
