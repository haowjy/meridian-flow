/** PostgreSQL coverage for crash recovery of claimed assistant turns. */
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { truncateDrizzleTables } from "../../../test-support/drizzle-reset.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
const USER_ID = "00000000-0000-4000-8000-000000000811";
const PROJECT_ID = "00000000-0000-4000-8000-000000000812";
const THREAD_ID = "00000000-0000-4000-8000-000000000813";
const USER_TURN_ID = "00000000-0000-4000-8000-000000000814";
const ASSISTANT_TURN_ID = "00000000-0000-4000-8000-000000000815";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("orphaned turn recovery (postgres)", () => {});
} else {
  describe("orphaned turn recovery (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createDrizzleEventJournalReader, createDrizzleEventJournalWriter } = await import(
      "../../threads/index.js"
    );
    const { createDrizzleRepositoriesForTest } = await import(
      "../../threads/adapters/drizzle/index.js"
    );
    const { createDrizzleThreadRunOwnership } = await import(
      "../adapters/drizzle-thread-run-ownership.js"
    );
    const { createOrphanedTurnRecovery } = await import("./orphaned-turn-recovery.js");
    const { listOrphanTurnCandidates } = await import(
      "../adapters/drizzle-orphan-turn-candidates.js"
    );

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 8 });
    const control = postgres(DATABASE_URL, { max: 1 });
    const repos = createDrizzleRepositoriesForTest(db);
    const reader = createDrizzleEventJournalReader(db);
    const writer = createDrizzleEventJournalWriter(db);
    const recoveryOwnership = createDrizzleThreadRunOwnership(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "orphan-turn-recovery"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Orphan recovery",
        slug: "orphan-recovery",
      });
      await db.insert(schema.threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Orphan recovery",
        status: "active",
      });
      await repos.turns.create({
        id: USER_TURN_ID,
        threadId: THREAD_ID,
        role: "user",
        status: "complete",
      });
      await repos.turns.create({
        id: ASSISTANT_TURN_ID,
        threadId: THREAD_ID,
        prevTurnId: USER_TURN_ID,
        role: "assistant",
        status: "streaming",
      });
    });

    afterAll(async () => {
      await control.end();
      await db.close();
    });

    function recovery(runOwnership = recoveryOwnership) {
      return createOrphanedTurnRecovery({
        listCandidates: (limit) => listOrphanTurnCandidates(db, limit),
        repos,
        eventWriter: writer,
        runOwnership,
      });
    }

    it("settles an owner killed at the PostgreSQL session and permits the next claim", async () => {
      const owner = createDrizzleThreadRunOwnership(db);
      const claim = await owner.tryAcquire(THREAD_ID);
      expect(claim).not.toBeNull();
      const [backend] = await control<{ pid: number }[]>`
        SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        ORDER BY pid DESC LIMIT 1
      `;
      // Killing the lock session emulates process death: Postgres owns lock cleanup.
      if (!backend) throw new Error("could not locate advisory-lock owner backend");
      await control`SELECT pg_terminate_backend(${backend.pid})`;
      await expect(recovery().sweep()).resolves.toBe(1);
      await expect(repos.turns.findById(ASSISTANT_TURN_ID)).resolves.toMatchObject({
        status: "error",
        finishReason: "error",
      });
      await expect(reader.listByType(THREAD_ID, "turn.error")).resolves.toHaveLength(1);
      const nextClaim = await recoveryOwnership.tryAcquire(THREAD_ID);
      expect(nextClaim).not.toBeNull();
      await expect(
        repos.turns.create({
          id: "00000000-0000-4000-8000-000000000816",
          threadId: THREAD_ID,
          prevTurnId: ASSISTANT_TURN_ID,
          role: "user",
          status: "complete",
        }),
      ).resolves.toMatchObject({ role: "user", status: "complete" });
      await nextClaim?.release();
    });

    it("leaves a live owner's streaming turn untouched", async () => {
      const owner = createDrizzleThreadRunOwnership(db);
      const claim = await owner.tryAcquire(THREAD_ID);
      expect(claim).not.toBeNull();
      await expect(recovery().sweep()).resolves.toBe(0);
      await expect(repos.turns.findById(ASSISTANT_TURN_ID)).resolves.toMatchObject({
        status: "streaming",
      });
      await claim?.release();
    });

    it("does not finalize a legitimate waiting_interrupt turn", async () => {
      await repos.turns.updateStatus(ASSISTANT_TURN_ID, { status: "waiting_interrupt" });
      await expect(recovery().sweep()).resolves.toBe(0);
      await expect(repos.turns.findById(ASSISTANT_TURN_ID)).resolves.toMatchObject({
        status: "waiting_interrupt",
      });
      await expect(reader.listByType(THREAD_ID, "turn.error")).resolves.toHaveLength(0);
    });

    it("writes one terminal event when multiple instances sweep concurrently", async () => {
      const anotherOwnership = createDrizzleThreadRunOwnership(db);
      const [first, second] = await Promise.all([
        recovery().sweep(),
        recovery(anotherOwnership).sweep(),
      ]);
      expect(first + second).toBe(1);
      await expect(reader.listByType(THREAD_ID, "turn.error")).resolves.toHaveLength(1);
      await expect(repos.turns.findById(ASSISTANT_TURN_ID)).resolves.toMatchObject({
        status: "error",
      });
    });
  });
}
