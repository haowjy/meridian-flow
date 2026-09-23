/** PostgreSQL terminal A: turn, report, journal, and publication share one commit. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const runDb = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;
const ids = {
  user: "00000000-0000-4000-8000-000000000ad1",
  project: "00000000-0000-4000-8000-000000000ad2",
  parent: "00000000-0000-4000-8000-000000000ad3" as ThreadId,
  child: "00000000-0000-4000-8000-000000000ad4" as ThreadId,
  parentTurn: "00000000-0000-4000-8000-000000000ad5" as TurnId,
  childUserTurn: "00000000-0000-4000-8000-000000000ad6" as TurnId,
  execution: "00000000-0000-4000-8000-000000000ad7" as TurnId,
};

if (!runDb || !databaseUrl) describe.skip("execution terminal A (postgres)", () => {});
else
  describe("execution terminal A (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createDrizzleRepositoriesForTest } = await import(
      "../../threads/adapters/drizzle/repositories.js"
    );
    const { createDrizzleEventJournalWriter } = await import("../../threads/index.js");
    const { finalizeExecution } = await import("./execution-finalizer.js");

    assertThrowawayDatabaseForRunDbTests(databaseUrl);
    const db = createDb(databaseUrl, { max: 6 });
    const repos = createDrizzleRepositoriesForTest(db);
    const eventWriter = createDrizzleEventJournalWriter(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(ids.user, "terminal-a"));
      await db.insert(schema.projects).values({
        id: ids.project,
        userId: ids.user,
        name: "Terminal A",
        slug: "terminal-a",
      });
      await db.insert(schema.threads).values([
        { id: ids.parent, projectId: ids.project, createdByUserId: ids.user, ref: "c1" },
        {
          id: ids.child,
          projectId: ids.project,
          createdByUserId: ids.user,
          ref: "p1",
          kind: "subagent",
          parentThreadId: ids.parent,
          rootThreadId: ids.parent,
          originTurnId: ids.parentTurn,
          originType: "spawn",
          spawnStatus: "running",
        },
      ]);
      await db.insert(schema.turns).values([
        { id: ids.parentTurn, threadId: ids.parent, role: "assistant", status: "complete" },
        { id: ids.childUserTurn, threadId: ids.child, role: "user", status: "complete" },
        {
          id: ids.execution,
          threadId: ids.child,
          parentTurnId: ids.childUserTurn,
          role: "assistant",
          status: "streaming",
        },
      ]);
      await repos.executionReports.admit({
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        handle: "p1",
        origin: "spawn",
        deliveryMode: "background_notification",
        callerThreadId: ids.parent,
        callerTurnId: ids.parentTurn,
        toolCallId: "spawn-1",
        cardBlockId: null,
      });
    });

    afterAll(async () => {
      await db.close();
    });

    it("rolls terminal turn and report obligation back together, then retries idempotently", async () => {
      await repos.executionReports.captureOnce(ids.child, ids.execution, "return-1", {
        summary: "candidate",
      });
      await expect(
        repos.transaction(async () => {
          await finalizeExecution(
            { repos, eventWriter },
            {
              threadId: ids.child,
              assistantTurnId: ids.execution,
              cause: { kind: "failed", reason: "budget", error: "budget exhausted" },
            },
          );
          throw new Error("outer rollback");
        }),
      ).rejects.toThrow("outer rollback");
      expect((await repos.turns.findById(ids.execution))?.status).toBe("streaming");
      expect(await repos.executionReports.findByExecution(ids.child, ids.execution)).toMatchObject({
        capture: { summary: "candidate" },
        outcome: null,
        publication: "none",
      });

      const first = await finalizeExecution(
        { repos, eventWriter },
        {
          threadId: ids.child,
          assistantTurnId: ids.execution,
          cause: { kind: "failed", reason: "budget", error: "budget exhausted" },
        },
      );
      expect(first.events.map((event) => event.type)).toEqual(["turn.error"]);
      expect(first.report).toMatchObject({
        outcome: "failed",
        source: "return_result",
        summary: "candidate",
        publication: "pending",
      });
      const replay = await finalizeExecution(
        { repos, eventWriter },
        {
          threadId: ids.child,
          assistantTurnId: ids.execution,
          cause: { kind: "failed", reason: "budget", error: "budget exhausted" },
        },
      );
      expect(replay.events).toEqual([]);
      expect(replay.report).toMatchObject({ outcome: "failed", publication: "pending" });
    });
  });
