/** PostgreSQL boundary coverage for immutable, exact per-execution report storage. */
import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const runDb = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;
const ids = {
  user: "00000000-0000-4000-8000-0000000009b1" as UserId,
  project: "00000000-0000-4000-8000-0000000009b2" as ProjectId,
  caller: "00000000-0000-4000-8000-0000000009b3" as ThreadId,
  child: "00000000-0000-4000-8000-0000000009b4" as ThreadId,
  callerTurn: "00000000-0000-4000-8000-0000000009b5" as TurnId,
  childUserTurn: "00000000-0000-4000-8000-0000000009ba" as TurnId,
  execution: "00000000-0000-4000-8000-0000000009b6" as TurnId,
  execution2: "00000000-0000-4000-8000-0000000009b7" as TurnId,
  otherRoot: "00000000-0000-4000-8000-0000000009b8" as ThreadId,
  otherChild: "00000000-0000-4000-8000-0000000009b9" as ThreadId,
  otherUser: "00000000-0000-4000-8000-0000000009bb" as UserId,
  otherProject: "00000000-0000-4000-8000-0000000009bc" as ProjectId,
  otherProjectRoot: "00000000-0000-4000-8000-0000000009bd" as ThreadId,
  otherProjectChild: "00000000-0000-4000-8000-0000000009be" as ThreadId,
  otherProjectRootTurn: "00000000-0000-4000-8000-0000000009bf" as TurnId,
  otherProjectChildUserTurn: "00000000-0000-4000-8000-0000000009c0" as TurnId,
  otherProjectExecution: "00000000-0000-4000-8000-0000000009c1" as TurnId,
};

if (!runDb || !databaseUrl) describe.skip("execution report repository (postgres)", () => {});
else
  describe("execution report repository (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleRepositoriesForTest } = await import("./repositories.js");
    const { readThreadReport } = await import("../../../runtime/spawn/read-thread-report.js");
    assertThrowawayDatabaseForRunDbTests(databaseUrl);
    const db = createDb(databaseUrl, { max: 6 });
    const repos = createDrizzleRepositoriesForTest(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(ids.user, "execution-report"));
      await db
        .insert(schema.users)
        .values(conformanceUserValues(ids.otherUser, "execution-report-other"));
      await db
        .insert(schema.projects)
        .values({ id: ids.project, userId: ids.user, name: "Reports", slug: "reports" });
      await db
        .insert(schema.projects)
        .values({ id: ids.otherProject, userId: ids.otherUser, name: "Other", slug: "other" });
      await db.insert(schema.threads).values([
        { id: ids.caller, projectId: ids.project, createdByUserId: ids.user, ref: "c1" },
        { id: ids.otherRoot, projectId: ids.project, createdByUserId: ids.user, ref: "c2" },
        {
          id: ids.otherProjectRoot,
          projectId: ids.otherProject,
          createdByUserId: ids.otherUser,
          ref: "c1",
        },
        {
          id: ids.child,
          projectId: ids.project,
          createdByUserId: ids.user,
          ref: "p1",
          kind: "subagent",
          parentThreadId: ids.caller,
          rootThreadId: ids.caller,
          originTurnId: ids.callerTurn,
          originType: "spawn",
          spawnStatus: "running",
        },
        {
          id: ids.otherChild,
          projectId: ids.project,
          createdByUserId: ids.user,
          ref: "p2",
          kind: "subagent",
          parentThreadId: ids.otherRoot,
          rootThreadId: ids.otherRoot,
          originTurnId: ids.callerTurn,
          originType: "spawn",
          spawnStatus: "running",
        },
        {
          id: ids.otherProjectChild,
          projectId: ids.otherProject,
          createdByUserId: ids.otherUser,
          ref: "p9",
          kind: "subagent",
          parentThreadId: ids.otherProjectRoot,
          rootThreadId: ids.otherProjectRoot,
          originTurnId: ids.otherProjectRootTurn,
          originType: "spawn",
          spawnStatus: "running",
        },
      ]);
      await db.insert(schema.turns).values([
        { id: ids.callerTurn, threadId: ids.caller, role: "assistant", status: "complete" },
        {
          id: ids.otherProjectRootTurn,
          threadId: ids.otherProjectRoot,
          role: "assistant",
          status: "complete",
        },
        { id: ids.childUserTurn, threadId: ids.child, role: "user", status: "complete" },
        {
          id: ids.otherProjectChildUserTurn,
          threadId: ids.otherProjectChild,
          role: "user",
          status: "complete",
        },
      ]);
      await db.insert(schema.turns).values([
        {
          id: ids.execution,
          threadId: ids.child,
          parentTurnId: ids.childUserTurn,
          role: "assistant",
          status: "streaming",
        },
        {
          id: ids.execution2,
          threadId: ids.child,
          parentTurnId: ids.childUserTurn,
          role: "assistant",
          status: "streaming",
        },
      ]);
      await db.insert(schema.turns).values({
        id: ids.otherProjectExecution,
        threadId: ids.otherProjectChild,
        parentTurnId: ids.otherProjectChildUserTurn,
        role: "assistant",
        status: "complete",
      });
      await repos.executionReports.admit({
        childThreadId: ids.otherProjectChild,
        assistantTurnId: ids.otherProjectExecution,
        handle: "p9",
        origin: "spawn",
        deliveryMode: "background_notification",
        callerThreadId: ids.otherProjectRoot,
        callerTurnId: ids.otherProjectRootTurn,
        toolCallId: "foreign",
        cardBlockId: null,
      });
      await repos.executionReports.finalizeOnce({
        childThreadId: ids.otherProjectChild,
        assistantTurnId: ids.otherProjectExecution,
        outcome: "succeeded",
        reason: null,
        source: "return_result",
        summary: "foreign secret",
      });
    });
    afterAll(async () => {
      await db.close();
    });

    it("keeps executions exact, idempotent, immutable and hidden behind live lineage reads", async () => {
      const input = {
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        handle: "p1",
        origin: "spawn" as const,
        deliveryMode: "background_notification" as const,
        callerThreadId: ids.caller,
        callerTurnId: ids.callerTurn,
        toolCallId: "call-a",
        cardBlockId: null,
      };
      await repos.executionReports.admit(input);
      await repos.executionReports.admit(input);
      const pending = await readThreadReport({
        callerThreadId: ids.caller,
        ref: "p1",
        execution: ids.execution,
        repos,
      });
      expect(pending).toEqual({ ref: "p1", execution: ids.execution, status: "not_ready" });
      await repos.executionReports.captureOnce(ids.child, ids.execution, "return-1", {
        summary: "kept",
      });
      await repos.executionReports.captureOnce(ids.child, ids.execution, "return-1", {
        summary: "kept",
      });
      await expect(
        repos.executionReports.captureOnce(ids.child, ids.execution, "return-2", {
          summary: "other",
        }),
      ).rejects.toThrow();
      await repos.executionReports.finalizeOnce({
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        outcome: "succeeded",
        reason: null,
        source: "return_result",
        summary: "kept",
        publication: "pending",
      });
      await repos.executionReports.finalizeOnce({
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        outcome: "succeeded",
        reason: null,
        source: "return_result",
        summary: "kept",
        publication: "pending",
      });
      await expect(
        repos.executionReports.finalizeOnce({
          childThreadId: ids.child,
          assistantTurnId: ids.execution,
          outcome: "failed",
          reason: "budget",
          source: "return_result",
          summary: "kept",
        }),
      ).rejects.toThrow();
      expect(await repos.executionReports.listPendingPublication(10)).toHaveLength(1);
      await repos.transaction(async () => {
        expect(
          await repos.executionReports.lockPendingPublication(ids.child, ids.execution),
        ).toMatchObject({ publication: "pending" });
        await repos.executionReports.markPublished(ids.child, ids.execution, "published");
      });
      expect(await repos.executionReports.listPendingPublication(10)).toHaveLength(0);
      expect(
        await readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          execution: ids.execution,
          repos,
        }),
      ).toMatchObject({ outcome: "succeeded", summary: "kept", partial: false });
      expect(
        await readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          execution: ids.execution2,
          repos,
        }),
      ).toMatchObject({ status: "unavailable" });
      await expect(
        readThreadReport({
          callerThreadId: ids.caller,
          ref: "p999",
          execution: ids.execution,
          repos,
        }),
      ).rejects.toThrow();
      await expect(
        readThreadReport({
          callerThreadId: ids.caller,
          ref: "p2",
          execution: ids.execution,
          repos,
        }),
      ).rejects.toThrow();
      await expect(
        readThreadReport({
          callerThreadId: ids.caller,
          ref: "p9",
          execution: ids.otherProjectExecution,
          repos,
        }),
      ).rejects.toThrow();
      await db
        .update(schema.threads)
        .set({ deletedAt: new Date() })
        .where((await import("drizzle-orm")).eq(schema.threads.id, ids.caller));
      await expect(
        readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          execution: ids.execution,
          repos,
        }),
      ).rejects.toThrow();
      expect(
        (await repos.executionReports.findByExecution(ids.child, ids.execution))?.summary,
      ).toBe("kept");
      await db
        .update(schema.threads)
        .set({ deletedAt: null })
        .where((await import("drizzle-orm")).eq(schema.threads.id, ids.caller));
      expect(
        await readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          execution: ids.execution,
          repos,
        }),
      ).toMatchObject({ summary: "kept" });
      await db
        .update(schema.threads)
        .set({ deletedAt: new Date() })
        .where((await import("drizzle-orm")).eq(schema.threads.id, ids.child));
      await expect(
        readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          execution: ids.execution,
          repos,
        }),
      ).rejects.toThrow();
      await db
        .update(schema.threads)
        .set({ deletedAt: null })
        .where((await import("drizzle-orm")).eq(schema.threads.id, ids.child));
      await db
        .update(schema.projects)
        .set({ deletedAt: new Date() })
        .where((await import("drizzle-orm")).eq(schema.projects.id, ids.project));
      await expect(
        readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          execution: ids.execution,
          repos,
        }),
      ).rejects.toThrow();
      await db
        .update(schema.projects)
        .set({ deletedAt: null })
        .where((await import("drizzle-orm")).eq(schema.projects.id, ids.project));
      await db
        .delete(schema.turns)
        .where((await import("drizzle-orm")).eq(schema.turns.id, ids.execution));
      expect(await repos.executionReports.findByExecution(ids.child, ids.execution)).toBeNull();
    });

    it("distinguishes empty success and rolls back uncommitted terminal state", async () => {
      await repos.executionReports.admit({
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        handle: "p1",
        origin: "thread_run",
        deliveryMode: "none",
        callerThreadId: null,
        callerTurnId: null,
        toolCallId: null,
        cardBlockId: null,
      });
      await expect(
        repos.transaction(async () => {
          await repos.executionReports.finalizeOnce({
            childThreadId: ids.child,
            assistantTurnId: ids.execution,
            outcome: "succeeded",
            reason: null,
            source: "empty",
            summary: "",
          });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await repos.executionReports.findByExecution(ids.child, ids.execution)).toMatchObject({
        outcome: null,
        summary: null,
      });
      await repos.executionReports.finalizeOnce({
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        outcome: "succeeded",
        reason: null,
        source: "empty",
        summary: "",
      });
      expect(
        await readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          execution: ids.execution,
          repos,
        }),
      ).toMatchObject({ outcome: "succeeded", source: "empty", summary: "" });
      await repos.executionReports.admit({
        childThreadId: ids.child,
        assistantTurnId: ids.execution2,
        handle: "p1",
        origin: "thread_run",
        deliveryMode: "none",
        callerThreadId: null,
        callerTurnId: null,
        toolCallId: null,
        cardBlockId: null,
      });
      await repos.executionReports.finalizeOnce({
        childThreadId: ids.child,
        assistantTurnId: ids.execution2,
        outcome: "failed",
        reason: "budget",
        source: "empty",
        summary: "",
      });
      expect(
        await readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          execution: ids.execution2,
          repos,
        }),
      ).toMatchObject({ outcome: "failed", source: "empty", summary: "", partial: true });
    });
  });
