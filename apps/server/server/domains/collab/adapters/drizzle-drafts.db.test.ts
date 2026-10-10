/** Proof that a Work's first drafted writes share one draft, and the resolver's lifecycle surface. */
import { createDb, type Database } from "@meridian/database";
import { assertThrowawayDatabaseForRunDbTests } from "@meridian/database/__test-support__/db-fixtures";
import { drafts, users } from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  approveDraftWriteJoin,
  DraftWriteJoinRefusedError,
} from "../../../shared/draft-write-join.js";
import { runInRootDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { draftTreeScenario } from "../../../test-support/draft-tree-scenario.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { createDrafts } from "../domain/drafts.js";
import { createDrizzleDraftStore, createDrizzleDraftWriteBoundary } from "./drizzle-drafts.js";
import { createInMemoryDraftStore, createInMemoryDraftWriteBoundary } from "./in-memory/drafts.js";

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

    it("makes one active draft when two first writes in a Work race, and serves its lifecycle (T-2)", async () => {
      const scenario = await draftTreeScenario(root);
      const work = await scenario.work("Ascension", "draft");
      const input = {
        workId: work.id,
        projectId: scenario.project.id,
        threadId: work.threadId,
        userId: scenario.project.userId,
      };

      // An ambient transaction the command boundary didn't approve is refused, not joined.
      await expect(
        runInRootDrizzleTransaction(first, () => resolverOn(first).ensureActiveForWrite(input)),
      ).rejects.toBeInstanceOf(DraftWriteJoinRefusedError);

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
        approveDraftWriteJoin();
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

      // The rest of the public surface, through the same resolver object.
      const resolver = resolverOn(root);
      expect(await resolver.activeForWork(work.id)).toMatchObject({ id: made.id });
      expect(await resolver.viewForWork(work.id)).toEqual({ kind: "draft", draftId: made.id });
      expect(await resolver.byIds([made.id])).toMatchObject([{ id: made.id, status: "active" }]);
      await runInRootDrizzleTransaction(root, async () => {
        expect(await resolver.shareActive(made.id)).toMatchObject({ id: made.id });
        expect(await resolver.lockActive(made.id)).toMatchObject({ id: made.id });
        await resolver.close(made.id, new Date());
      });
      expect(await resolver.activeForWork(work.id)).toBeNull();
      expect(await resolver.viewForWork(work.id)).toEqual({ kind: "live" });
      expect(await resolver.shareActive(made.id)).toBeNull();
      expect(await resolver.lockActive(made.id)).toBeNull();
      expect(await resolver.byOriginWork(work.id)).toMatchObject([
        { id: made.id, status: "closed" },
      ]);

      // The in-memory adapter keeps the same rule for concurrent first writes.
      const memoryStore = createInMemoryDraftStore();
      const memory = createDrafts({
        store: memoryStore,
        boundary: createInMemoryDraftWriteBoundary(),
      });
      const racing = await Promise.all(
        Array.from({ length: 20 }, () => memory.ensureActiveForWrite(input)),
      );
      expect(new Set(racing.map((draft) => draft.id)).size).toBe(1);
      expect(await memory.byOriginWork(work.id)).toHaveLength(1);
    });
  });
}
