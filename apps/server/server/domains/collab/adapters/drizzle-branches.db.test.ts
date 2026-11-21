/** Proof that drafted writes lock a Work's draft behind the Work, and the resolver's surface. */
import { createDb, type Database } from "@meridian/database";
import { assertThrowawayDatabaseForRunDbTests } from "@meridian/database/__test-support__/db-fixtures";
import { users, works } from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  approveBranchWriteJoin,
  BranchWriteJoinRefusedError,
} from "../../../shared/branch-write-join.js";
import { runInRootDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { branchTreeScenario } from "../../../test-support/branch-tree-scenario.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";
import { createBranches } from "../domain/branches.js";
import { createDrizzleBranchStore, createDrizzleBranchWriteBoundary } from "./drizzle-branches.js";

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
  describe.skip("drizzle branches (postgres)", () => {});
} else {
  describe("drizzle branches (postgres)", () => {
    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const root = createDb(DATABASE_URL, { max: 2 });
    const first = createDb(DATABASE_URL, { max: 1 });
    const second = createDb(DATABASE_URL, { max: 1 });
    const resolverOn = (db: Database) =>
      createBranches({
        store: createDrizzleBranchStore(db),
        boundary: createDrizzleBranchWriteBoundary(db, createTestWorkProjectionMutation(db)),
      });

    beforeEach(() => deleteDrizzleRows(root, [users]));
    afterAll(async () => {
      await Promise.all([root.close(), first.close(), second.close()]);
    });

    it("locks a Work's draft for a write behind its owner, and resolves it both ways (T-2)", async () => {
      const scenario = await branchTreeScenario(root);
      const work = await scenario.work("Ascension", "draft");
      const owner = { kind: "work", workId: work.id } as const;

      // An ambient transaction the command boundary didn't approve is refused, not joined.
      await expect(
        runInRootDrizzleTransaction(first, () => resolverOn(first).lockForWrite(owner)),
      ).rejects.toBeInstanceOf(BranchWriteJoinRefusedError);

      // The first write's command transaction locks the draft and stays open.
      let locked!: () => void;
      const lockedSignal = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const firstWrite = runInRootDrizzleTransaction(first, async () => {
        approveBranchWriteJoin();
        const draft = await resolverOn(first).lockForWrite(owner);
        locked();
        await held;
        return draft;
      });
      await lockedSignal;
      const secondWrite = resolverOn(second).lockForWrite(owner);
      const secondOrder = await Promise.race([
        secondWrite.then(
          () => "settled" as const,
          () => "settled" as const,
        ),
        lockWait(root),
      ]);
      release();
      const [made, joined] = await Promise.all([firstWrite, secondWrite]);

      const [named] = await root
        .select({ draftId: works.draftId })
        .from(works)
        .where(eq(works.id, work.id));
      expect(made.id).toBe(named?.draftId);
      expect(joined.id).toBe(made.id);
      // The second write waited on the Work row rather than reading around it.
      expect(secondOrder).toBe("waiting");

      // The rest of the public surface, through the same resolver object.
      const resolver = resolverOn(root);
      expect(await resolver.ofOwner(owner)).toMatchObject({ id: made.id });
      expect(await resolver.ownerOf(made.id)).toMatchObject({ owner, branch: { id: made.id } });
      expect(await resolver.viewForOwner(owner)).toEqual({ kind: "branch", branchId: made.id });
      expect(await resolver.byIds([made.id])).toMatchObject([{ id: made.id }]);
      await runInRootDrizzleTransaction(root, async () => {
        expect(await resolver.share(made.id)).toMatchObject({ id: made.id });
        expect(await resolver.lock(made.id)).toMatchObject({ id: made.id });
      });
    });
  });
}
