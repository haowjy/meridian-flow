/**
 * One describe block for the draft-tree DB suites that drive the composed runtime and
 * commit (settlement owns root transactions; races run on several connections): its own
 * pool, composed runtimes cleaned per case, and users plus settlement batches (which
 * belong to no user) deleted before each case. Skipped without a test database.
 */
import { createDb, type Database } from "@meridian/database";
import { branchPushSettlementBatches, users } from "@meridian/database/schema";
import { afterAll, beforeEach, describe } from "vitest";
import { useComposedRuntimes } from "./composed-runtime.js";
import {
  type DraftTreeScenario,
  draftTreeScenario,
  type ScenarioRuntime,
} from "./draft-tree-scenario.js";
import { deleteDrizzleRows } from "./drizzle-reset.js";

export type DraftTreeStart = () => Promise<{ runtime: ScenarioRuntime; s: DraftTreeScenario }>;

export function describeDraftTreeDb(
  name: string,
  cases: (start: DraftTreeStart, db: Database) => void,
): void {
  const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
  const url = process.env.DATABASE_URL;
  if (!enabled || !url) {
    describe.skip(name, () => {});
    return;
  }
  describe(name, () => {
    const db = createDb(url, { max: 12 });
    afterAll(() => db.close());
    const runtimes = useComposedRuntimes(() => db);
    beforeEach(async () => {
      await deleteDrizzleRows(db, [users, branchPushSettlementBatches]);
    });
    cases(async () => {
      const runtime = await runtimes.compose();
      return { runtime, s: await draftTreeScenario(db, { runtime, runtimes }) };
    }, db);
  });
}
