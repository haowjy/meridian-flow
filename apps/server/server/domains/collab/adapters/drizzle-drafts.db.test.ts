/** Postgres proof that a Work's first drafted writes share one draft across connections. */
import { createDb, type Database } from "@meridian/database";
import { assertThrowawayDatabaseForRunDbTests } from "@meridian/database/__test-support__/db-fixtures";
import { drafts, users } from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runInRootDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { draftTreeScenario } from "../../../test-support/draft-tree-scenario.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { createDrafts } from "../domain/drafts.js";
import { createDrizzleDraftStore, createDrizzleDraftWriteBoundary } from "./drizzle-drafts.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

/** Resolves once another backend of this database waits on a lock (PostgreSQL's own timing). */
async function lockWait(db: Database, timeoutMs = 5_000): Promise<"waiting" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db.execute<{ waiting: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted AND a.datname = current_database()
      ) AS waiting`);
    if (row?.waiting) return "waiting";
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return "timeout";
}

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle drafts (postgres)", () => {});
} else {
  describe("drizzle drafts (postgres)", () => {
    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const root = createDb(DATABASE_URL, { max: 2 });
    const first = createDb(DATABASE_URL, { max: 1 });
    const second = createDb(DATABASE_URL, { max: 1 });
    const resolverOn = (db: Database) =>
      createDrafts({
        store: createDrizzleDraftStore(db),
        boundary: createDrizzleDraftWriteBoundary(db),
      });

    beforeEach(() => deleteDrizzleRows(root, [users]));
    afterAll(async () => {
      await Promise.all([root.close(), first.close(), second.close()]);
    });

    it("makes one active draft when two first writes in a Work race (T-2)", async () => {
      const scenario = await draftTreeScenario(root);
      const work = await scenario.work("Ascension", "draft");
      const input = {
        workId: work.id,
        projectId: scenario.project.id,
        threadId: work.threadId,
        userId: scenario.project.userId,
      };

      // The first write's command transaction ensures the draft and stays open.
      let ensured!: () => void;
      const ensuredSignal = new Promise<void>((resolve) => {
        ensured = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const firstWrite = runInRootDrizzleTransaction(first, async () => {
        const draft = await resolverOn(first).ensureActiveForWrite(input);
        ensured();
        await held;
        return draft;
      });
      await ensuredSignal;
      const secondWrite = resolverOn(second).ensureActiveForWrite(input);
      const secondOrder = await Promise.race([
        secondWrite.then(
          () => "settled" as const,
          () => "settled" as const,
        ),
        lockWait(root),
      ]);
      release();
      const [made, joined] = await Promise.all([firstWrite, secondWrite]);

      const active = await root
        .select({ id: drafts.id })
        .from(drafts)
        .where(and(eq(drafts.originWorkId, work.id), eq(drafts.status, "active")));
      expect(active).toEqual([{ id: made.id }]);
      expect(joined.id).toBe(made.id);
      // The second write waited on the Work row rather than reading around it.
      expect(secondOrder).toBe("waiting");
    });
  });
}
