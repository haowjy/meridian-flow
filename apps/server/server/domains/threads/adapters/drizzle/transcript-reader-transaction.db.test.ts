/**
 * PostgreSQL transaction-boundary coverage for transcript reads and orphan repair.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - ambient-transaction orphan repair (kb/decisions/chat/turns/linear-turns.md)
 */
import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createQuietDrizzleJournalWriter } from "../../../../test-support/journal-writer.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
const USER_ID = "00000000-0000-4000-8000-0000000006c1" as UserId;
const PROJECT_ID = "00000000-0000-4000-8000-0000000006c2" as ProjectId;
const THREAD_ID = "00000000-0000-4000-8000-0000000006c3" as ThreadId;
const FIRST_TURN_ID = "00000000-0000-4000-8000-0000000006c4" as TurnId;
const SECOND_TURN_ID = "00000000-0000-4000-8000-0000000006c5" as TurnId;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("transcript reader transactions (postgres)", () => {});
} else {
  describe("transcript reader transactions (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { sql } = await import("drizzle-orm");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { deleteDrizzleRows } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleRepositoriesForTest } = await import("./repositories.js");
    const { readTranscriptPage } = await import("../../domain/transcript-page.js");
    const { createDrizzleThreadLock } = await import(
      "../../../runtime/adapters/drizzle-thread-lock.js"
    );
    const { finalizeOrphanedTurns } = await import("../../../runtime/loop/orphaned-placeholder.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 4 });
    const repos = createDrizzleRepositoriesForTest(db);

    beforeEach(async () => {
      await deleteDrizzleRows(db, [schema.users]);
      await db
        .insert(schema.users)
        .values(conformanceUserValues(USER_ID, "transcript-transaction"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Transcript transaction",
        slug: "transcript-transaction",
      });
      await db.insert(schema.threads).values({
        rootThreadId: THREAD_ID,
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
      });
      await db.insert(schema.turns).values([
        {
          id: FIRST_TURN_ID,
          threadId: THREAD_ID,
          parentTurnId: null,
          position: 1,
          role: "user",
          origin: "writer",
          status: "complete",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCostUsd: "0",
          responseCount: 0,
        },
        {
          id: SECOND_TURN_ID,
          threadId: THREAD_ID,
          parentTurnId: FIRST_TURN_ID,
          position: 2,
          role: "assistant",
          origin: "assistant",
          status: "complete",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCostUsd: "0",
          responseCount: 0,
        },
      ] as never);
      await db.insert(schema.turnBlocks).values([
        {
          id: crypto.randomUUID(),
          turnId: FIRST_TURN_ID,
          blockType: "text",
          sequence: 0,
          modelText: "writer",
          content: { text: "writer" },
        },
        {
          id: crypto.randomUUID(),
          turnId: SECOND_TURN_ID,
          blockType: "text",
          sequence: 0,
          modelText: "answer",
          content: { text: "answer" },
        },
      ] as never);
    });

    afterAll(() => db.close());

    it("reads unsettled, anchor, boundary, and page rows from one repeatable-read snapshot", async () => {
      const insertedWriterId = crypto.randomUUID() as TurnId;
      const insertedUnsettledId = crypto.randomUUID() as TurnId;
      const bake = await repos.promptBakes.create({
        ownerThreadId: THREAD_ID,
        composedSystemPrompt: "concurrent bake",
        bakedSkillSlugs: [],
        bakedTools: [],
        contentHash: "concurrent-bake",
      });
      const thread = await repos.threads.findByIdIncludingDeleted(THREAD_ID);
      if (!thread) throw new Error("Snapshot fixture thread missing");

      const snapshotRepos = {
        ...repos,
        async readSnapshot<T>(operation: () => Promise<T>) {
          return repos.readSnapshot(async () => {
            await repos.threads.findByIdIncludingDeleted(THREAD_ID);
            await db.insert(schema.turns).values([
              {
                id: insertedWriterId,
                threadId: THREAD_ID,
                parentTurnId: SECOND_TURN_ID,
                position: 3,
                role: "user",
                origin: "writer",
                status: "complete",
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalCostUsd: "0",
                responseCount: 0,
              },
              {
                id: insertedUnsettledId,
                threadId: THREAD_ID,
                parentTurnId: insertedWriterId,
                position: 4,
                role: "assistant",
                origin: "assistant",
                status: "streaming",
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalCostUsd: "0",
                responseCount: 0,
              },
            ] as never);
            await db
              .update(schema.turns)
              .set({ promptBakeId: bake.id })
              .where(sql`${schema.turns.id} = ${SECOND_TURN_ID}::uuid`);
            await db.insert(schema.turnBlocks).values({
              id: crypto.randomUUID(),
              turnId: insertedWriterId,
              blockType: "text",
              sequence: 0,
              modelText: "committed after snapshot",
              content: { text: "committed after snapshot" },
            } as never);
            return operation();
          });
        },
      };

      const page = await readTranscriptPage(snapshotRepos, thread, {
        order: "newest_first",
        unit: "item",
        limit: 1,
      });
      expect(page.entries.flatMap((entry) => entry.turn.id)).not.toContain(insertedWriterId);
      expect(page.unsettledTail).toBeUndefined();
      const cursor = JSON.parse(
        Buffer.from(page.nextCursor as string, "base64url").toString("utf8"),
      ) as { a: [number, number] };
      expect(cursor.a).toEqual([2, 0]);
      expect(page.segment.index).toBe(0);
      expect(page.segmentBoundary).toBe(false);
    });

    it("orphan repair reads unsettled turns through its thread-lock transaction", async () => {
      const threadLock = createDrizzleThreadLock(db);
      await threadLock.withThreadLock(THREAD_ID, async () => {
        const pendingWriter = await repos.turns.create({
          threadId: THREAD_ID,
          prevTurnId: SECOND_TURN_ID,
          role: "user",
          origin: "writer",
          status: "pending",
        });
        const originalList = repos.turns.listUnsettledForThread.bind(repos.turns);
        const observedRepos = {
          ...repos,
          turns: {
            ...repos.turns,
            async listUnsettledForThread(threadId: ThreadId) {
              const unsettled = await originalList(threadId);
              expect(unsettled.map((turn) => turn.id)).toContain(pendingWriter.id);
              return unsettled;
            },
          },
        };
        await finalizeOrphanedTurns(
          { repos: observedRepos, eventWriter: createQuietDrizzleJournalWriter(db) },
          { threadId: THREAD_ID },
        );
      });
    });
  });
}
