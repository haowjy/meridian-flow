/** PostgreSQL persistence and latest-response ordering for cache predictions. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  resetThreadWorkRaceFixture,
  THREAD_WORK_RACE,
} from "../../test-support/thread-work-postgres-harness.js";

const RUN = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN || !DATABASE_URL) describe.skip("model response cache prediction (postgres)", () => {});
else
  describe("model response cache prediction (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const { createDrizzleRepositoriesForTest } = await import("./repositories.js");
    const db = createDb(DATABASE_URL, { max: 4 });
    const repos = createDrizzleRepositoriesForTest(db);
    const ids = THREAD_WORK_RACE;

    beforeEach(async () => {
      await resetThreadWorkRaceFixture(db);
    });
    afterAll(() => db.close());

    it("round-trips both prediction columns and selects by turn position then sequence", async () => {
      const firstTurn = await repos.turns.create({
        threadId: ids.threadId as never,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      const lastTurn = await repos.turns.create({
        threadId: ids.threadId as never,
        prevTurnId: firstTurn.id,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      const base = {
        provider: "test-provider",
        model: "test-model",
        priceSource: "unknown" as const,
      };
      await repos.modelResponses.create({ ...base, turnId: firstTurn.id, sequence: 9 });
      await repos.modelResponses.create({ ...base, turnId: lastTurn.id, sequence: 0 });
      const newest = await repos.modelResponses.create({
        ...base,
        turnId: lastTurn.id,
        sequence: 2,
        predictedCacheState: "warm",
        predictedCacheReason: "reusable_prefix",
      });

      await expect(repos.modelResponses.findById(newest.row.id)).resolves.toMatchObject({
        predictedCacheState: "warm",
        predictedCacheReason: "reusable_prefix",
      });
      await expect(repos.modelResponses.findLatestByThread(ids.threadId as never)).resolves.toEqual(
        {
          turnId: lastTurn.id,
          sequence: 2,
          model: "test-model",
          createdAt: newest.row.createdAt,
        },
      );
    });
  });
