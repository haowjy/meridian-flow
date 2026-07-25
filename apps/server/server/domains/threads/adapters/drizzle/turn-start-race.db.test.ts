/** Postgres regression coverage for cross-instance turn-start serialization. */

import type { TurnId } from "@meridian/contracts/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000451";
const PROJECT_ID = "00000000-0000-4000-8000-000000000452";
const THREAD_ID = "00000000-0000-4000-8000-000000000453";
const FIRST_ROOT_ID = "00000000-0000-4000-8000-000000000454";
const SECOND_ROOT_ID = "00000000-0000-4000-8000-000000000455";
const FIRST_ASSISTANT_ID = "00000000-0000-4000-8000-000000000456";
const SECOND_ASSISTANT_ID = "00000000-0000-4000-8000-000000000457";

function postgresErrorCode(error: unknown): string | null {
  let current = error;
  while (current && typeof current === "object") {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : null;
  }
  return null;
}

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("turn start serialization (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("turn start serialization (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { TurnStartConflictError } = await import("../../domain/turn-start-transition.js");
    const { createDrizzleRepositories } = await import("./repositories.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 4 });
    const firstInstance = createDrizzleRepositories(db);
    const secondInstance = createDrizzleRepositories(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "turn-start-race"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Turn Start Race",
        slug: "turn-start-race",
      });
      await db.insert(schema.threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Empty thread",
        kind: "primary",
        status: "idle",
      });
    });

    afterAll(async () => {
      await db.close();
    });

    it("returns a domain conflict instead of leaking the single-root unique violation", async () => {
      const results = await Promise.allSettled([
        firstInstance.turns.create({
          id: FIRST_ROOT_ID,
          threadId: THREAD_ID,
          role: "user",
          status: "complete",
        }),
        secondInstance.turns.create({
          id: SECOND_ROOT_ID,
          threadId: THREAD_ID,
          role: "user",
          status: "complete",
        }),
      ]);

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(postgresErrorCode(rejected[0]?.reason)).not.toBe("23505");
      expect(rejected[0]?.reason).toBeInstanceOf(TurnStartConflictError);

      const turns = await firstInstance.turns.listByThread(THREAD_ID);
      const thread = await firstInstance.threads.findById(THREAD_ID);
      expect(turns).toHaveLength(1);
      expect(thread?.activeLeafTurnId).toBe(turns[0]?.id);
    });

    it("admits only one cross-instance turn-start transition", async () => {
      async function start(
        instance: typeof firstInstance,
        userTurnId: TurnId,
        assistantTurnId: TurnId,
      ) {
        return instance.runTurnStartTransition(THREAD_ID, null, async () => {
          await instance.turns.create({
            id: userTurnId,
            threadId: THREAD_ID,
            role: "user",
            status: "complete",
          });
          return instance.turns.create({
            id: assistantTurnId,
            threadId: THREAD_ID,
            prevTurnId: userTurnId,
            role: "assistant",
            status: "streaming",
          });
        });
      }

      const results = await Promise.allSettled([
        start(firstInstance, FIRST_ROOT_ID, FIRST_ASSISTANT_ID),
        start(secondInstance, SECOND_ROOT_ID, SECOND_ASSISTANT_ID),
      ]);

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(TurnStartConflictError);
      expect(rejected[0]?.reason).toMatchObject({ reason: "already_running" });
      expect(postgresErrorCode(rejected[0]?.reason)).toBeNull();

      const turns = await firstInstance.turns.listByThread(THREAD_ID);
      const thread = await firstInstance.threads.findById(THREAD_ID);
      expect(turns).toHaveLength(2);
      expect(thread?.activeLeafTurnId).toBe(fulfilled[0]?.value.id);
    });
  });
}
