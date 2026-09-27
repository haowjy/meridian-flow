/** PostgreSQL contract tests for serialized, write-once turn positions. */
import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
const USER_ID = "00000000-0000-4000-8000-0000000006a1" as UserId;
const PROJECT_ID = "00000000-0000-4000-8000-0000000006a2" as ProjectId;
const SOURCE_THREAD_ID = "00000000-0000-4000-8000-0000000006a3" as ThreadId;
const FORK_THREAD_ID = "00000000-0000-4000-8000-0000000006a4" as ThreadId;
const FIRST_TURN_ID = "00000000-0000-4000-8000-0000000006a5" as TurnId;
const SECOND_TURN_ID = "00000000-0000-4000-8000-0000000006a6" as TurnId;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("turn position (postgres)", () => {});
} else {
  describe("turn position (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleRepositoriesForTest } = await import("./repositories.js");
    const { planMessageTurns } = await import("../../../runtime/loop/inbox-context.js");
    const { persistAndAppendTurnStartEvents } = await import(
      "../../../runtime/loop/persistence.js"
    );

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 6 });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "turn-position"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Turn positions",
        slug: "turn-positions",
      });
      await db.insert(schema.threads).values({
        id: SOURCE_THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
      });
    });

    afterAll(async () => {
      await db.close();
    });

    it("assigns ordered positions to a drained inbox turn and prevents position edits", async () => {
      const repos = createDrizzleRepositoriesForTest(db);
      const first = await repos.turns.create({
        id: FIRST_TURN_ID,
        threadId: SOURCE_THREAD_ID,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      const newerWriterTurn = await repos.turns.create({
        id: SECOND_TURN_ID,
        threadId: SOURCE_THREAD_ID,
        prevTurnId: first.id,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      const queuedAt = new Date(Date.now() - 60_000).toISOString();
      const inboxId = "00000000-0000-4000-8000-0000000006a7";

      const batch = [
        {
          id: inboxId,
          threadId: SOURCE_THREAD_ID,
          intent: "message" as const,
          provenance: { kind: "writer" as const, actorId: USER_ID },
          body: { kind: "text" as const, text: "queued earlier" },
          idempotencyKey: inboxId,
          seq: 1,
          enqueuedAt: queuedAt,
          deliveredAt: null,
        },
      ];
      const plan = planMessageTurns({
        threadId: SOURCE_THREAD_ID,
        prevTurnId: newerWriterTurn.id,
        prevTurnPosition: newerWriterTurn.position,
        knownTurnIds: new Set(),
        batch,
      });
      const persisted = await persistAndAppendTurnStartEvents(
        {
          repos,
          eventWriter: {
            async appendEvent() {
              return 1n;
            },
          },
        },
        SOURCE_THREAD_ID,
        newerWriterTurn.id,
        async () => ({ result: undefined, events: plan.events }),
      );
      expect(persisted.createdTurns.map((turn) => turn.position)).toEqual([3]);

      const turns = await repos.turns.listByThread(SOURCE_THREAD_ID);
      expect(turns.map((turn) => turn.id)).toEqual([first.id, newerWriterTurn.id, inboxId]);
      expect(turns.map((turn) => turn.position)).toEqual([1, 2, 3]);
      expect(turns[2]?.createdAt).not.toBe(queuedAt);
      await expect(
        db
          .update(schema.turns)
          .set({ position: 4 })
          .where((await import("drizzle-orm")).eq(schema.turns.id, first.id)),
      ).rejects.toThrow();
    });

    it("continues a fork's local positions after the source cutoff", async () => {
      const repos = createDrizzleRepositoriesForTest(db);
      const first = await repos.turns.create({
        id: FIRST_TURN_ID,
        threadId: SOURCE_THREAD_ID,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      const cutoff = await repos.turns.create({
        id: SECOND_TURN_ID,
        threadId: SOURCE_THREAD_ID,
        prevTurnId: first.id,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      await db.insert(schema.threads).values({
        id: FORK_THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        originType: "fork",
        originTurnId: cutoff.id,
      });
      const forkFirst = await repos.turns.create({
        threadId: FORK_THREAD_ID,
        prevTurnId: cutoff.id,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      const forkSecond = await repos.turns.create({
        threadId: FORK_THREAD_ID,
        prevTurnId: forkFirst.id,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });

      expect(cutoff.position).toBe(2);
      expect(forkFirst.position).toBe(3);
      expect(forkSecond.position).toBe(4);
    });
  });
}
