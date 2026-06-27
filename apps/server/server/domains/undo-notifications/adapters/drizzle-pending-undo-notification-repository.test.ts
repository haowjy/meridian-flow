/** Postgres round-trip coverage for pending undo notification consumption. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000301";
const PROJECT_ID = "00000000-0000-4000-8000-000000000302";
const CONTEXT_SOURCE_ID = "00000000-0000-4000-8000-000000000303";
const THREAD_ID = "00000000-0000-4000-8000-000000000304";
const OTHER_THREAD_ID = "00000000-0000-4000-8000-000000000305";
const TURN_ID = "00000000-0000-4000-8000-000000000306";
const SECOND_TURN_ID = "00000000-0000-4000-8000-000000000307";
const OTHER_TURN_ID = "00000000-0000-4000-8000-000000000308";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle pending undo notification repository (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("drizzle pending undo notification repository (postgres)", async () => {
    const { eq } = await import("drizzle-orm");
    const { createDb } = await import("@meridian/database");
    const dbSchema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createDrizzlePendingUndoNotificationRepository } = await import(
      "./drizzle-pending-undo-notification-repository.js"
    );

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);

    const { contextSources, pendingUndoNotifications, projects, threads, turns, users } = dbSchema;
    const db = createDb(DATABASE_URL, { max: 1 });

    async function truncateAll(): Promise<void> {
      await truncateDrizzleTables(db, [
        pendingUndoNotifications,
        turns,
        threads,
        contextSources,
        projects,
        users,
      ]);
    }

    async function ensureFixtures(): Promise<void> {
      await db.insert(users).values(conformanceUserValues(USER_ID, "pending-undo"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Pending Undo Project",
        slug: "pending-undo-project",
      });
      await db.insert(contextSources).values({
        id: CONTEXT_SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
      });
      await db.insert(threads).values([
        {
          id: THREAD_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: "Thread",
          kind: "primary",
          status: "idle",
        },
        {
          id: OTHER_THREAD_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: "Other Thread",
          kind: "primary",
          status: "idle",
        },
      ]);
      await db.insert(turns).values([
        { id: TURN_ID, threadId: THREAD_ID, role: "assistant", status: "complete" },
        {
          id: SECOND_TURN_ID,
          threadId: THREAD_ID,
          parentTurnId: TURN_ID,
          role: "assistant",
          status: "complete",
        },
        { id: OTHER_TURN_ID, threadId: OTHER_THREAD_ID, role: "assistant", status: "complete" },
      ]);
    }

    beforeEach(async () => {
      await truncateAll();
      await ensureFixtures();
    });

    afterAll(async () => {
      await db.close();
    });

    it("records rows and clears only the consumed thread", async () => {
      const repo = createDrizzlePendingUndoNotificationRepository(db);
      await repo.record({
        threadId: THREAD_ID,
        writeHandles: ["w1", "w2"],
        writeHandleTurns: [
          { writeHandle: "w1", turnId: TURN_ID },
          { writeHandle: "w2", turnId: TURN_ID },
        ],
        uri: "manuscript://chapter-1.md",
        direction: "undo",
      });
      await repo.record({
        threadId: OTHER_THREAD_ID,
        writeHandles: ["w3"],
        writeHandleTurns: [{ writeHandle: "w3", turnId: OTHER_TURN_ID }],
        uri: "manuscript://chapter-2.md",
        direction: "undo",
      });

      const consumed = await repo.consumeForThread(THREAD_ID);
      expect(
        consumed.map((row) => ({ writeHandle: row.writeHandle, direction: row.direction })),
      ).toEqual([
        { writeHandle: "w1", direction: "undo" },
        { writeHandle: "w2", direction: "undo" },
      ]);
      expect(await repo.consumeForThread(THREAD_ID)).toEqual([]);
      expect((await repo.consumeForThread(OTHER_THREAD_ID)).map((row) => row.writeHandle)).toEqual([
        "w3",
      ]);
    });

    it("coalesces same-millisecond rows by insertion order so the latest record wins", async () => {
      const repo = createDrizzlePendingUndoNotificationRepository(db);
      const uri = "manuscript://chapter-1.md";

      await repo.record({
        threadId: THREAD_ID,
        writeHandles: ["redone", "undone", "first-only"],
        writeHandleTurns: [
          { writeHandle: "redone", turnId: TURN_ID },
          { writeHandle: "undone", turnId: TURN_ID },
          { writeHandle: "first-only", turnId: TURN_ID },
        ],
        uri,
        direction: "undo",
      });
      await repo.record({
        threadId: THREAD_ID,
        writeHandles: ["redone", "undone"],
        writeHandleTurns: [
          { writeHandle: "redone", turnId: SECOND_TURN_ID },
          { writeHandle: "undone", turnId: SECOND_TURN_ID },
        ],
        uri,
        direction: "redo",
      });
      await repo.record({
        threadId: THREAD_ID,
        writeHandles: ["undone", "second-only"],
        writeHandleTurns: [
          { writeHandle: "undone", turnId: SECOND_TURN_ID },
          { writeHandle: "second-only", turnId: SECOND_TURN_ID },
        ],
        uri,
        direction: "undo",
      });

      const sameMillisecond = new Date("2026-06-27T00:00:00.000Z");
      await db
        .update(pendingUndoNotifications)
        .set({ createdAt: sameMillisecond })
        .where(eq(pendingUndoNotifications.threadId, THREAD_ID));

      const consumed = await repo.consumeForThread(THREAD_ID);
      expect(
        consumed.map((row) => ({
          writeHandle: row.writeHandle,
          turnId: row.turnId,
          direction: row.direction,
        })),
      ).toEqual([
        { writeHandle: "undone", turnId: SECOND_TURN_ID, direction: "undo" },
        { writeHandle: "first-only", turnId: TURN_ID, direction: "undo" },
        { writeHandle: "second-only", turnId: SECOND_TURN_ID, direction: "undo" },
      ]);
    });
  });
}
