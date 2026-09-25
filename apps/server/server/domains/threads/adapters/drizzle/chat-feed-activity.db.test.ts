/** Postgres contracts for the stored conversational chat activity projection. */
import { createDb } from "@meridian/database";
import {
  assertThrowawayDatabaseForRunDbTests,
  conformanceUserValues,
} from "@meridian/database/__test-support__/db-fixtures";
import * as schema from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { truncateDrizzleTables } from "../../../../test-support/drizzle-reset.js";
import { createDrizzleRepositoriesForTest } from "./repositories.js";

const USER = "00000000-0000-4000-8000-000000000891";
const PROJECT = "00000000-0000-4000-8000-000000000892";
const THREAD = "00000000-0000-4000-8000-000000000893";
const url = process.env.DATABASE_URL;

if (!url || !["1", "true"].includes(process.env.RUN_DB_TESTS ?? "")) {
  describe.skip("chat feed activity (postgres)", () => {});
} else {
  assertThrowawayDatabaseForRunDbTests(url);
  describe("chat feed activity (postgres)", () => {
    const db = createDb(url, { max: 3 });
    const repos = createDrizzleRepositoriesForTest(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users, schema.threads]);
      await db.insert(schema.users).values(conformanceUserValues(USER, "chat-activity"));
      await db
        .insert(schema.projects)
        .values({ id: PROJECT, userId: USER, name: "Chat", slug: "chat" });
      await db
        .insert(schema.threads)
        .values({ id: THREAD, projectId: PROJECT, createdByUserId: USER });
    });
    afterAll(() => db.close());

    async function activity() {
      return (
        await repos.chatFeed.queryPage({
          projectId: PROJECT,
          userId: USER,
          after: null,
          limit: 10,
          favorite: false,
          search: null,
        })
      )[0]?.lastActivityAt;
    }

    it("advances when the active conversational turn completes", async () => {
      const turn = await repos.turns.create({
        threadId: THREAD,
        role: "assistant",
        createdAt: "2025-01-01T00:00:00.000Z",
      });
      expect(await activity()).toBe("2025-01-01T00:00:00.000000Z");
      await repos.turns.updateStatus(turn.id, {
        status: "complete",
        completedAt: "2025-01-01T00:01:00.000Z",
      });
      expect(await activity()).toBe("2025-01-01T00:01:00.000000Z");
    });

    it("does not advance for a hidden work-context system update", async () => {
      const first = await repos.turns.create({
        threadId: THREAD,
        role: "user",
        createdAt: "2025-01-01T00:00:00.000Z",
      });
      const hidden = await repos.turns.create({
        threadId: THREAD,
        prevTurnId: first.id,
        role: "user",
        metadata: { kind: "system_update", section: "work_context" },
        createdAt: "2025-01-01T00:05:00.000Z",
      });
      await repos.turns.updateStatus(hidden.id, {
        status: "complete",
        completedAt: "2025-01-01T00:06:00.000Z",
      });
      expect(await activity()).toBe("2025-01-01T00:00:00.000000Z");
    });

    it("changes activity when a branch switches the active leaf", async () => {
      const root = await repos.turns.create({
        threadId: THREAD,
        role: "user",
        createdAt: "2025-01-01T00:00:00.000Z",
      });
      await repos.turns.create({
        threadId: THREAD,
        prevTurnId: root.id,
        role: "assistant",
        createdAt: "2025-01-01T00:02:00.000Z",
      });
      const branch = await repos.turns.create({
        threadId: THREAD,
        prevTurnId: root.id,
        role: "assistant",
        createdAt: "2025-01-01T00:01:00.000Z",
      });
      expect(await activity()).toBe("2025-01-01T00:01:00.000000Z");
      const [stored] = await db
        .select({ leaf: schema.threads.conversationalLeafTurnId })
        .from(schema.threads)
        .where(eq(schema.threads.id, THREAD));
      expect(stored?.leaf).toBe(branch.id);
    });

    it("pages across equal activity timestamps using descending thread IDs", async () => {
      const second = "00000000-0000-4000-8000-000000000894";
      await db
        .insert(schema.threads)
        .values({ id: second, projectId: PROJECT, createdByUserId: USER });
      const timestamp = new Date("2025-01-01T00:00:00.000Z");
      await db
        .update(schema.threads)
        .set({ lastActivityAt: timestamp })
        .where(eq(schema.threads.projectId, PROJECT));
      const firstPage = await repos.chatFeed.queryPage({
        projectId: PROJECT,
        userId: USER,
        after: null,
        limit: 1,
        favorite: false,
        search: null,
      });
      const cursor = firstPage[0];
      if (!cursor) throw new Error("Expected first cursor page to contain a chat");
      const nextPage = await repos.chatFeed.queryPage({
        projectId: PROJECT,
        userId: USER,
        after: { sortAt: cursor.lastActivityAt, threadId: cursor.id },
        limit: 1,
        favorite: false,
        search: null,
      });
      expect(firstPage.map((item) => item.id)).toEqual([second]);
      expect(nextPage.map((item) => item.id)).toEqual([THREAD]);
    });
  });
}
