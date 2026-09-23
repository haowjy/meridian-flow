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
    let activeExecution: TurnId | null = null;
    const runningTurn = { readRunningTurnId: async () => activeExecution };

    beforeEach(async () => {
      activeExecution = null;
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

    it("normalizes exact selectors and distinguishes active from stranded admissions", async () => {
      const input = {
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        handle: "p1",
        origin: "thread_run" as const,
        deliveryMode: "none" as const,
        callerThreadId: null,
        callerTurnId: null,
        toolCallId: null,
        cardBlockId: null,
      };
      await repos.executionReports.admit(input);
      expect(
        await readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          execution: ids.execution.toUpperCase(),
          repos,
          runningTurn,
        }),
      ).toEqual({
        ref: "p1",
        execution: ids.execution,
        status: "unavailable",
      });
      activeExecution = ids.execution;
      expect(
        await readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          execution: ids.execution,
          repos,
          runningTurn,
        }),
      ).toMatchObject({ status: "not_ready" });
      activeExecution = ids.execution2;
      expect(
        await readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          execution: ids.execution,
          repos,
          runningTurn,
        }),
      ).toMatchObject({ status: "unavailable" });
      await expect(
        readThreadReport({
          callerThreadId: ids.caller,
          ref: "c1",
          execution: ids.execution,
          repos,
          runningTurn,
        }),
      ).rejects.toThrow();
      const { eq } = await import("drizzle-orm");
      await db.update(schema.threads).set({ ref: "p5" }).where(eq(schema.threads.id, ids.caller));
      await expect(
        readThreadReport({
          callerThreadId: ids.caller,
          ref: "p5",
          execution: ids.execution,
          repos,
          runningTurn,
        }),
      ).rejects.toThrow();
      await db.update(schema.threads).set({ ref: "c1" }).where(eq(schema.threads.id, ids.caller));
      await expect(
        readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          execution: "not-a-uuid",
          repos,
          runningTurn,
        }),
      ).rejects.toThrow();
      expect(
        await readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          execution: "00000000-0000-0000-0000-000000000001",
          repos,
          runningTurn,
        }),
      ).toMatchObject({ status: "unavailable" });
    });

    it("rejects mismatched existing child, caller turn, handle and card identities", async () => {
      const input = {
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        handle: "p1",
        origin: "spawn" as const,
        deliveryMode: "background_notification" as const,
        callerThreadId: ids.caller,
        callerTurnId: ids.callerTurn,
        toolCallId: "call",
        cardBlockId: null,
      };
      await expect(repos.executionReports.admit({ ...input, handle: "p2" })).rejects.toThrow();
      await expect(
        repos.executionReports.admit({ ...input, childThreadId: ids.otherChild }),
      ).rejects.toThrow();
      await expect(
        repos.executionReports.admit({ ...input, assistantTurnId: ids.childUserTurn }),
      ).rejects.toThrow();
      await expect(
        repos.executionReports.admit({ ...input, callerTurnId: ids.childUserTurn }),
      ).rejects.toThrow();
      const foreignCaller = "00000000-0000-4000-8000-0000000009d7" as ThreadId;
      const foreignTurn = "00000000-0000-4000-8000-0000000009d8" as TurnId;
      await db.insert(schema.threads).values({
        id: foreignCaller,
        projectId: ids.project,
        createdByUserId: ids.otherUser,
        ref: "p4",
        kind: "subagent",
        parentThreadId: ids.caller,
        rootThreadId: ids.caller,
        originType: "spawn",
        originTurnId: ids.callerTurn,
        spawnStatus: "running",
      });
      await db.insert(schema.turns).values({
        id: foreignTurn,
        threadId: foreignCaller,
        role: "assistant",
        status: "complete",
      });
      await expect(
        repos.executionReports.admit({
          ...input,
          callerThreadId: foreignCaller,
          callerTurnId: foreignTurn,
        }),
      ).rejects.toThrow();
      const cardId = "00000000-0000-4000-8000-0000000009d0";
      await db
        .insert(schema.turnBlocks)
        .values({ id: cardId, turnId: ids.childUserTurn, blockType: "custom", sequence: 1 });
      await expect(
        repos.executionReports.admit({ ...input, cardBlockId: cardId }),
      ).rejects.toThrow();
      expect(await repos.executionReports.findByExecution(ids.child, ids.execution)).toBeNull();
    });

    it("derives publication from delivery and retains terminal content through retries and rollback", async () => {
      const input = {
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        handle: "p1",
        origin: "spawn" as const,
        deliveryMode: "background_notification" as const,
        callerThreadId: ids.caller,
        callerTurnId: ids.callerTurn,
        toolCallId: "call",
        cardBlockId: null,
      };
      await expect(
        repos.transaction(async () => {
          await repos.executionReports.admit(input);
          throw new Error("rollback admission");
        }),
      ).rejects.toThrow("rollback admission");
      expect(await repos.executionReports.findByExecution(ids.child, ids.execution)).toBeNull();
      await repos.executionReports.admit(input);
      await expect(
        repos.transaction(async () => {
          await repos.executionReports.captureOnce(ids.child, ids.execution, "return", {
            summary: "candidate",
          });
          throw new Error("rollback capture");
        }),
      ).rejects.toThrow("rollback capture");
      expect(
        (await repos.executionReports.findByExecution(ids.child, ids.execution))?.capture,
      ).toBeNull();
      await repos.executionReports.captureOnce(ids.child, ids.execution, "return", {
        summary: "candidate",
      });
      const terminal = {
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        outcome: "succeeded" as const,
        reason: null,
        source: "return_result" as const,
        summary: "candidate",
      };
      expect(await repos.executionReports.finalizeOnce(terminal)).toMatchObject({
        publication: "pending",
      });
      await expect(
        repos.transaction(async () => {
          await repos.executionReports.markPublished(ids.child, ids.execution, "published");
          throw new Error("rollback publication");
        }),
      ).rejects.toThrow("rollback publication");
      expect(
        (await repos.executionReports.findByExecution(ids.child, ids.execution))?.publication,
      ).toBe("pending");
      await repos.executionReports.markPublished(ids.child, ids.execution, "published");
      expect(await repos.executionReports.finalizeOnce(terminal)).toMatchObject({
        publication: "published",
        summary: "candidate",
      });
      expect(
        await repos.executionReports.captureOnce(ids.child, ids.execution, "return", {
          summary: "candidate",
        }),
      ).toMatchObject({ publication: "published" });
      await expect(
        repos.executionReports.finalizeOnce({ ...terminal, summary: "changed" }),
      ).rejects.toThrow();
      await repos.executionReports.admit({
        ...input,
        assistantTurnId: ids.execution2,
        origin: "thread_run",
        deliveryMode: "none",
        callerThreadId: null,
        callerTurnId: null,
        toolCallId: null,
      });
      expect(
        await repos.executionReports.finalizeOnce({ ...terminal, assistantTurnId: ids.execution2 }),
      ).toMatchObject({ publication: "none" });
    });

    it("discovers live obligations beyond parked callers and retains child output after caller deletion", async () => {
      const { eq } = await import("drizzle-orm");
      await repos.executionReports.markPublished(
        ids.otherProjectChild,
        ids.otherProjectExecution,
        "skipped",
      );
      const sibling = "00000000-0000-4000-8000-0000000009d1" as ThreadId;
      const siblingTurn = "00000000-0000-4000-8000-0000000009d2" as TurnId;
      const third = "00000000-0000-4000-8000-0000000009d3" as TurnId;
      const card = "00000000-0000-4000-8000-0000000009d4";
      await db.insert(schema.threads).values({
        id: sibling,
        projectId: ids.project,
        createdByUserId: ids.user,
        ref: "p3",
        kind: "subagent",
        parentThreadId: ids.caller,
        rootThreadId: ids.caller,
        originType: "spawn",
        originTurnId: ids.callerTurn,
        spawnStatus: "running",
      });
      await db.insert(schema.turns).values([
        { id: siblingTurn, threadId: sibling, role: "assistant", status: "complete" },
        {
          id: third,
          threadId: ids.child,
          parentTurnId: ids.childUserTurn,
          role: "assistant",
          status: "complete",
        },
      ]);
      await db
        .insert(schema.turnBlocks)
        .values({ id: card, turnId: siblingTurn, blockType: "custom", sequence: 1 });
      for (const execution of [ids.execution, ids.execution2]) {
        await repos.executionReports.admit({
          childThreadId: ids.child,
          assistantTurnId: execution,
          handle: "p1",
          origin: "spawn",
          deliveryMode: "background_notification",
          callerThreadId: sibling,
          callerTurnId: siblingTurn,
          toolCallId: `call-${execution}`,
          cardBlockId: card,
        });
        await repos.executionReports.finalizeOnce({
          childThreadId: ids.child,
          assistantTurnId: execution,
          outcome: "succeeded",
          reason: null,
          source: "return_result",
          summary: `saved-${execution}`,
        });
      }
      await repos.executionReports.admit({
        childThreadId: ids.child,
        assistantTurnId: third,
        handle: "p1",
        origin: "spawn",
        deliveryMode: "background_notification",
        callerThreadId: ids.caller,
        callerTurnId: ids.callerTurn,
        toolCallId: "live",
        cardBlockId: null,
      });
      await repos.executionReports.finalizeOnce({
        childThreadId: ids.child,
        assistantTurnId: third,
        outcome: "succeeded",
        reason: null,
        source: "return_result",
        summary: "live",
      });
      await db
        .update(schema.threads)
        .set({ deletedAt: new Date() })
        .where(eq(schema.threads.id, sibling));
      expect(await repos.executionReports.listPendingPublication(1)).toEqual([
        {
          childThreadId: ids.child,
          assistantTurnId: third,
          callerThreadId: ids.caller,
        },
      ]);
      await db
        .update(schema.threads)
        .set({ deletedAt: null })
        .where(eq(schema.threads.id, sibling));
      expect(
        (await repos.executionReports.listPendingPublication(3)).map((row) => row.assistantTurnId),
      ).toEqual(expect.arrayContaining([ids.execution, ids.execution2, third]));
      await db.delete(schema.turns).where(eq(schema.turns.id, siblingTurn));
      await db.delete(schema.threads).where(eq(schema.threads.id, sibling));
      expect(await repos.executionReports.findByExecution(ids.child, ids.execution)).toMatchObject({
        callerThreadId: null,
        callerTurnId: null,
        cardBlockId: null,
        summary: `saved-${ids.execution}`,
      });
      expect(await repos.executionReports.listPendingPublication(1)).toHaveLength(1);
    });

    it("does not reveal an authorized sibling's report through a mismatched ref or another owner", async () => {
      const sibling = "00000000-0000-4000-8000-0000000009d5" as ThreadId;
      const foreignCaller = "00000000-0000-4000-8000-0000000009d6" as ThreadId;
      await db.insert(schema.threads).values([
        {
          id: sibling,
          projectId: ids.project,
          createdByUserId: ids.user,
          ref: "p3",
          kind: "subagent",
          parentThreadId: ids.caller,
          rootThreadId: ids.caller,
          originType: "spawn",
          originTurnId: ids.callerTurn,
          spawnStatus: "running",
        },
        {
          id: foreignCaller,
          projectId: ids.project,
          createdByUserId: ids.otherUser,
          ref: "p4",
          kind: "subagent",
          parentThreadId: ids.caller,
          rootThreadId: ids.caller,
          originType: "spawn",
          originTurnId: ids.callerTurn,
          spawnStatus: "running",
        },
      ]);
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
      await repos.executionReports.finalizeOnce({
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        outcome: "succeeded",
        reason: null,
        source: "return_result",
        summary: "secret",
      });
      expect(
        await readThreadReport({
          callerThreadId: ids.caller,
          ref: "p3",
          execution: ids.execution,
          repos,
          runningTurn,
        }),
      ).toMatchObject({ status: "unavailable" });
      await expect(
        readThreadReport({
          callerThreadId: foreignCaller,
          ref: "p1",
          execution: ids.execution,
          repos,
          runningTurn,
        }),
      ).rejects.toThrow();
    });

    it("uses a fresh authorized root snapshot instead of the caller's uncommitted transaction", async () => {
      const input = {
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        handle: "p1",
        origin: "thread_run" as const,
        deliveryMode: "none" as const,
        callerThreadId: null,
        callerTurnId: null,
        toolCallId: null,
        cardBlockId: null,
      };
      await repos.transaction(async () => {
        await repos.executionReports.admit(input);
        expect(
          await readThreadReport({
            callerThreadId: ids.caller,
            ref: "p1",
            execution: ids.execution,
            repos,
            runningTurn,
          }),
        ).toMatchObject({ status: "unavailable" });
      });
      expect(
        await readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          execution: ids.execution,
          repos,
          runningTurn,
        }),
      ).toMatchObject({ status: "unavailable" });
      activeExecution = ids.execution;
      expect(
        await readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          execution: ids.execution,
          repos,
          runningTurn,
        }),
      ).toMatchObject({ status: "not_ready" });
    });

    it("serializes competing capture and finalization contenders without replacing a winner", async () => {
      const input = {
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        handle: "p1",
        origin: "spawn" as const,
        deliveryMode: "direct" as const,
        callerThreadId: ids.caller,
        callerTurnId: ids.callerTurn,
        toolCallId: "call",
        cardBlockId: null,
      };
      await repos.executionReports.admit(input);
      const captures = await Promise.allSettled([
        repos.executionReports.captureOnce(ids.child, ids.execution, "a", { summary: "A" }),
        repos.executionReports.captureOnce(ids.child, ids.execution, "b", { summary: "B" }),
      ]);
      expect(captures.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(captures.filter((result) => result.status === "rejected")).toHaveLength(1);
      const savedCapture = await repos.executionReports.findByExecution(ids.child, ids.execution);
      expect(savedCapture?.captureToolCallId).toMatch(/^[ab]$/);
      const terminals = await Promise.allSettled([
        repos.executionReports.finalizeOnce({
          childThreadId: ids.child,
          assistantTurnId: ids.execution,
          outcome: "succeeded",
          reason: null,
          source: "return_result",
          summary: "A",
        }),
        repos.executionReports.finalizeOnce({
          childThreadId: ids.child,
          assistantTurnId: ids.execution,
          outcome: "failed",
          reason: "error",
          source: "return_result",
          summary: "B",
        }),
      ]);
      expect(terminals.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(terminals.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(
        (await repos.executionReports.findByExecution(ids.child, ids.execution))?.publication,
      ).toBe("pending");
      let releaseFirst = () => {};
      let firstLocked = () => {};
      const firstLock = new Promise<void>((resolve) => {
        firstLocked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const publisherA = repos.transaction(async () => {
        expect(
          await repos.executionReports.lockPendingPublication(ids.child, ids.execution),
        ).toMatchObject({ publication: "pending" });
        firstLocked();
        await release;
        await repos.executionReports.markPublished(ids.child, ids.execution, "published");
      });
      await firstLock;
      const publisherB = repos.transaction(async () => {
        return repos.executionReports.lockPendingPublication(ids.child, ids.execution);
      });
      releaseFirst();
      const [, losingLock] = await Promise.all([publisherA, publisherB]);
      expect(losingLock).toBeNull();
      await repos.executionReports.markPublished(ids.child, ids.execution, "skipped");
      expect(
        (await repos.executionReports.findByExecution(ids.child, ids.execution))?.publication,
      ).toBe("published");
    });

    it("keeps capture, terminal, and publication retries immutable", async () => {
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
      activeExecution = ids.execution;
      const pending = await readThreadReport({
        callerThreadId: ids.caller,
        ref: "p1",
        execution: ids.execution,
        repos,
        runningTurn,
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
      });
      await repos.executionReports.finalizeOnce({
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        outcome: "succeeded",
        reason: null,
        source: "return_result",
        summary: "kept",
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
      expect(await repos.executionReports.listPendingPublication(10)).toContainEqual({
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        callerThreadId: ids.caller,
      });
      await repos.transaction(async () => {
        expect(
          await repos.executionReports.lockPendingPublication(ids.child, ids.execution),
        ).toMatchObject({ publication: "pending" });
        await repos.executionReports.markPublished(ids.child, ids.execution, "published");
      });
      expect(await repos.executionReports.listPendingPublication(10)).not.toContainEqual({
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        callerThreadId: ids.caller,
      });
      expect(
        await readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          execution: ids.execution,
          repos,
          runningTurn,
        }),
      ).toMatchObject({ outcome: "succeeded", summary: "kept", partial: false });
    });

    it("hides exact reports behind live caller, target, project and turn ownership", async () => {
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
      await repos.executionReports.finalizeOnce({
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        outcome: "succeeded",
        reason: null,
        source: "return_result",
        summary: "kept",
      });
      expect(
        await readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          execution: ids.execution2,
          repos,
          runningTurn,
        }),
      ).toMatchObject({ status: "unavailable" });
      await expect(
        readThreadReport({
          callerThreadId: ids.caller,
          ref: "p999",
          execution: ids.execution,
          repos,
          runningTurn,
        }),
      ).rejects.toThrow();
      await expect(
        readThreadReport({
          callerThreadId: ids.caller,
          ref: "p2",
          execution: ids.execution,
          repos,
          runningTurn,
        }),
      ).rejects.toThrow();
      await expect(
        readThreadReport({
          callerThreadId: ids.caller,
          ref: "p9",
          execution: ids.otherProjectExecution,
          repos,
          runningTurn,
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
          runningTurn,
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
          runningTurn,
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
          runningTurn,
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
          runningTurn,
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

    it("rolls back uncommitted terminal state", async () => {
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
    });

    it("distinguishes empty success and rereads an older exact report after continuation", async () => {
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
          runningTurn,
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
          runningTurn,
        }),
      ).toMatchObject({ outcome: "failed", source: "empty", summary: "", partial: true });
      expect(
        await readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          execution: ids.execution,
          repos,
          runningTurn,
        }),
      ).toMatchObject({
        outcome: "succeeded",
        source: "empty",
        summary: "",
      });
    });
  });
