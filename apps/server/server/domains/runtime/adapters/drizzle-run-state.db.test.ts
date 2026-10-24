/**
 * PostgreSQL coverage for the run-state publication participant: lock tracking, savepoints and the flush.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - thread-lock-scoped run-state publication with savepoint and flush phase tracking (kb/decisions/engineering/runtime/runtime-delivery-and-run-claim.md)
 */

import type { ThreadId } from "@meridian/contracts/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { journalEventsByThread } from "../../../test-support/journal-events.js";
import { createQuietDrizzleJournalWriter } from "../../../test-support/journal-writer.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-0000000009a1";
const PROJECT_ID = "00000000-0000-4000-8000-0000000009a2";
const THREAD_A = "00000000-0000-4000-8000-0000000009a3" as ThreadId;
const THREAD_B = "00000000-0000-4000-8000-0000000009a4" as ThreadId;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("run-state publication (postgres)", () => {});
} else {
  describe("run-state publication (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { deleteDrizzleRows } = await import("../../../test-support/drizzle-reset.js");
    const { eventSeqForJournalEvent } = await import("../../threads/index.js");
    const { enlistDrizzleTransactionParticipant, runInDrizzleSavepoint, runInDrizzleTransaction } =
      await import("../../../shared/drizzle-transaction.js");
    const { createDrizzleInbox } = await import("./drizzle-inbox.js");
    const { createDrizzleThreadLock } = await import("./drizzle-thread-lock.js");
    const { answerRunState, markRunStateChanged, publishRunState } = await import(
      "./drizzle-run-state.js"
    );

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 6 });
    const lock = createDrizzleThreadLock(db, createQuietDrizzleJournalWriter(db));
    const inbox = createDrizzleInbox(db);

    beforeEach(async () => {
      await deleteDrizzleRows(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "run-state"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Run State",
        slug: "run-state",
      });
      for (const [id, title] of [
        [THREAD_A, "Thread A"],
        [THREAD_B, "Thread B"],
      ] as const)
        await db.insert(schema.threads).values({
          rootThreadId: id,
          id,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title,
        });
    });
    afterAll(() => db.close());

    const records = async (threadId: ThreadId) =>
      (await journalEventsByThread(db, threadId)).filter(
        (row) => row.eventType === "run_state.changed",
      );
    const message = (key: string, threadId = THREAD_A) => ({
      threadId,
      intent: "message" as const,
      provenance: { kind: "writer" as const, actorId: USER_ID },
      body: { kind: "text" as const, text: key },
      idempotencyKey: key,
    });

    it("refuses a mark on a chat whose thread lock the transaction doesn't hold", async () => {
      await expect(
        runInDrizzleTransaction(db, async () => markRunStateChanged(THREAD_A)),
      ).rejects.toThrow("without the thread lock");
    });

    it("counts a lock taken in a released savepoint and forgets one taken in a rolled-back one", async () => {
      await runInDrizzleTransaction(db, async () => {
        await runInDrizzleSavepoint(db, () => lock.withThreadLock(THREAD_A, async () => {}));
        markRunStateChanged(THREAD_A);
        await expect(
          runInDrizzleSavepoint(db, async () => {
            await lock.withThreadLock(THREAD_B, async () => {});
            throw new Error("rolled back");
          }),
        ).rejects.toThrow("rolled back");
        expect(() => markRunStateChanged(THREAD_B)).toThrow("without the thread lock");
      });
      expect(await records(THREAD_A)).toHaveLength(1);
      expect(await records(THREAD_B)).toHaveLength(0);
    });

    it("appends a second, newer record for a write after an early publication", async () => {
      const first = await lock.withThreadLock(THREAD_A, async () => {
        await inbox.enqueue(message("one"));
        const early = await publishRunState(THREAD_A);
        await inbox.enqueue(message("two"));
        return early;
      });
      const rows = await records(THREAD_A);
      expect(rows).toHaveLength(2);
      expect(first.version).toBe(eventSeqForJournalEvent(rows[0]?.seq as bigint, 0).toString());
      expect((rows[1]?.payload as { runState: { items: unknown[] } }).runState.items).toHaveLength(
        2,
      );
      expect(rows[1]?.seq as bigint).toBeGreaterThan(rows[0]?.seq as bigint);
    });

    it("refuses an input write that lands after the flush", async () => {
      await expect(
        lock.withThreadLock(THREAD_A, async () => {
          // Enlisted after the publication participant, so it flushes after it.
          enlistDrizzleTransactionParticipant({
            key: {},
            create: () => ({}),
            fork: () => ({}),
            merge: (_parent, child) => child,
            beforeCommit: async () => markRunStateChanged(THREAD_A),
          });
        }),
      ).rejects.toThrow("after its record was published");
    });

    it("answers inside a savepoint with the record an ancestor's write made, published now", async () => {
      const answer = await lock.withThreadLock(THREAD_A, async () => {
        await inbox.enqueue(message("ancestor"));
        return runInDrizzleSavepoint(db, () => answerRunState(THREAD_A));
      });
      const rows = await records(THREAD_A);
      // Published by the answer itself, not re-read at the old head, and not published twice at commit.
      expect(rows).toHaveLength(1);
      expect(answer.version).toBe(eventSeqForJournalEvent(rows[0]?.seq as bigint, 0).toString());
      expect(answer.items).toHaveLength(1);
    });
  });
}
