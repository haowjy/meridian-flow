/** PostgreSQL B and orphan recovery: exact parent publication after durable terminal A. */
import { buildHelperResultComponentContent } from "@meridian/contracts/components";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const runDb = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;
const ids = {
  user: "00000000-0000-4000-8000-000000000be1",
  project: "00000000-0000-4000-8000-000000000be2",
  parent: "00000000-0000-4000-8000-000000000be3" as ThreadId,
  child: "00000000-0000-4000-8000-000000000be4" as ThreadId,
  parentTurn: "00000000-0000-4000-8000-000000000be5" as TurnId,
  childUserTurn: "00000000-0000-4000-8000-000000000be6" as TurnId,
  execution: "00000000-0000-4000-8000-000000000be7" as TurnId,
  card: "00000000-0000-4000-8000-000000000be8",
  root: "00000000-0000-4000-8000-000000000be9" as ThreadId,
  rootTurn: "00000000-0000-4000-8000-000000000bea" as TurnId,
  nextExecution: "00000000-0000-4000-8000-000000000beb" as TurnId,
};

if (!runDb || !databaseUrl) describe.skip("report publication and recovery (postgres)", () => {});
else
  describe("report publication and recovery (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { eq } = await import("drizzle-orm");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createDrizzleRepositoriesForTest } = await import(
      "../../threads/adapters/drizzle/repositories.js"
    );
    const { createDrizzleEventJournalWriter } = await import("../../threads/index.js");
    const { createInMemoryEventSink } = await import("../../observability/index.js");
    const { createDrizzleInbox } = await import("../adapters/drizzle-inbox.js");
    const { createDrizzleThreadLock } = await import("../adapters/drizzle-thread-lock.js");
    const { createDrizzleRunAuthority } = await import(
      "../adapters/drizzle-thread-run-ownership.js"
    );
    const { createThreadedInbox } = await import("../loop/threaded-inbox.js");
    const { finalizeExecution } = await import("../loop/execution-finalizer.js");
    const { createReportPublisher } = await import("./report-publisher.js");
    const { createOrphanReportRepair } = await import("./orphan-report-repair.js");

    assertThrowawayDatabaseForRunDbTests(databaseUrl);
    const db = createDb(databaseUrl, { max: 6 });
    const repos = createDrizzleRepositoriesForTest(db);
    const eventWriter = createDrizzleEventJournalWriter(db);
    const inbox = createDrizzleInbox(db);
    const threadLock = createDrizzleThreadLock(db);
    const eventSink = createInMemoryEventSink();
    const threadedInbox = createThreadedInbox({
      inbox,
      threadLock,
      runStarter: { async start() {} },
      schedulePostCommit() {},
    });
    const publisher = createReportPublisher({ repos, eventWriter, threadedInbox, eventSink });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(ids.user, "publication-b"));
      await db.insert(schema.projects).values({
        id: ids.project,
        userId: ids.user,
        name: "Publication B",
        slug: "publication-b",
      });
      await db.insert(schema.threads).values({
        id: ids.root,
        projectId: ids.project,
        createdByUserId: ids.user,
        ref: "c1",
      });
      await db.insert(schema.threads).values([
        {
          id: ids.parent,
          projectId: ids.project,
          createdByUserId: ids.user,
          ref: "p0",
          kind: "subagent",
          parentThreadId: ids.root,
          rootThreadId: ids.root,
          originTurnId: ids.rootTurn,
          originType: "spawn",
          spawnStatus: "succeeded",
        },
        {
          id: ids.child,
          projectId: ids.project,
          createdByUserId: ids.user,
          ref: "p1",
          kind: "subagent",
          parentThreadId: ids.parent,
          rootThreadId: ids.root,
          originTurnId: ids.parentTurn,
          originType: "spawn",
          spawnStatus: "running",
        },
      ]);
      await db.insert(schema.turns).values([
        { id: ids.rootTurn, threadId: ids.root, role: "assistant", status: "complete" },
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
      await db.insert(schema.turnBlocks).values({
        id: ids.card,
        turnId: ids.parentTurn,
        blockType: "custom",
        sequence: 7,
        content: buildHelperResultComponentContent({
          agentSlug: "critic",
          agentName: "Critic",
          status: "running",
          parentTurnId: ids.parentTurn,
          childThreadId: ids.child,
        }),
      });
      await repos.executionReports.admit({
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        handle: "p1",
        origin: "spawn",
        deliveryMode: "background_notification",
        callerThreadId: ids.parent,
        callerTurnId: ids.parentTurn,
        toolCallId: "spawn-1",
        cardBlockId: ids.card,
        agentSlug: "critic",
      });
    });
    afterAll(async () => {
      await db.close();
    });

    async function terminal() {
      await repos.executionReports.captureOnce(ids.child, ids.execution, "return-1", {
        summary: "secret report body",
        payload: { private: "detail" },
      });
      await finalizeExecution(
        { repos, eventWriter },
        {
          threadId: ids.child,
          assistantTurnId: ids.execution,
          cause: { kind: "success", finishReason: "end_turn", finalPublicText: "" },
        },
      );
    }

    it("publishes exact card replacement, metadata event and compact inbox once", async () => {
      await terminal();
      expect(await publisher.publish(ids.child, ids.execution)).toBe("published");
      expect(await publisher.publish(ids.child, ids.execution)).toBe("already");
      const card = await repos.blocks.findById(ids.card);
      expect(card).toMatchObject({ id: ids.card, turnId: ids.parentTurn, sequence: 7 });
      expect(card?.content).toMatchObject({
        kind: "helper-result",
        props: { status: "completed", execution: ids.execution },
      });
      expect(JSON.stringify(card?.content)).not.toContain("secret report body");
      const events = await db
        .select()
        .from(schema.eventJournal)
        .where(eq(schema.eventJournal.threadId, ids.parent));
      expect(events.map((row) => row.eventType)).toEqual(["block.updated", "agent.run_completed"]);
      expect(JSON.stringify(events.map((row) => row.payload))).not.toContain("secret report body");
      const messages = await inbox.listPending(ids.parent);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        provenance: { kind: "child", threadId: ids.child, reportId: ids.execution },
      });
      expect(JSON.stringify(messages)).toContain(
        `thread_report({\\"ref\\":\\"p1\\",\\"execution\\":\\"${ids.execution}\\"})`,
      );
      expect(JSON.stringify(messages)).not.toContain("secret report body");
      expect(
        (await repos.executionReports.findByExecution(ids.child, ids.execution))?.publication,
      ).toBe("published");
    });

    it("rolls back card, event, inbox and marker together on publication failure, then retries", async () => {
      await terminal();
      const failing = createReportPublisher({
        repos,
        eventWriter: {
          async appendEvent() {
            throw new Error("journal unavailable");
          },
        },
        threadedInbox,
        eventSink,
      });
      await expect(failing.publish(ids.child, ids.execution)).rejects.toThrow(
        "journal unavailable",
      );
      expect((await repos.blocks.findById(ids.card))?.content).toMatchObject({
        kind: "helper-result",
        props: { status: "running" },
      });
      expect(await inbox.listPending(ids.parent)).toEqual([]);
      expect(
        (await repos.executionReports.findByExecution(ids.child, ids.execution))?.publication,
      ).toBe("pending");
      expect(await publisher.publish(ids.child, ids.execution)).toBe("published");
    });

    it("serializes competing publishers and does not recreate a deleted card", async () => {
      await terminal();
      await db.delete(schema.turnBlocks).where(eq(schema.turnBlocks.id, ids.card));
      const outcomes = await Promise.all([
        publisher.publish(ids.child, ids.execution),
        publisher.publish(ids.child, ids.execution),
      ]);
      expect(outcomes.sort()).toEqual(["already", "published"]);
      expect(await repos.blocks.findById(ids.card)).toBeNull();
      expect(await inbox.listPending(ids.parent)).toHaveLength(1);
      const events = await db
        .select()
        .from(schema.eventJournal)
        .where(eq(schema.eventJournal.threadId, ids.parent));
      expect(events.map((row) => row.eventType)).toEqual(["agent.run_completed"]);
    });

    it("advances a bounded sweep past one failing publication", async () => {
      await terminal();
      await db.insert(schema.turns).values({
        id: ids.nextExecution,
        threadId: ids.child,
        parentTurnId: ids.execution,
        role: "assistant",
        status: "streaming",
      });
      await repos.executionReports.admit({
        childThreadId: ids.child,
        assistantTurnId: ids.nextExecution,
        handle: "p1",
        origin: "foreground_message",
        deliveryMode: "direct",
        callerThreadId: ids.parent,
        callerTurnId: ids.parentTurn,
        toolCallId: "message-2",
        cardBlockId: null,
      });
      await finalizeExecution(
        { repos, eventWriter },
        {
          threadId: ids.child,
          assistantTurnId: ids.nextExecution,
          cause: { kind: "success", finishReason: "end_turn", finalPublicText: "second" },
        },
      );
      const failingFirst = createReportPublisher({
        repos,
        eventWriter: {
          async appendEvent(threadId, event) {
            if (event.type === "agent.run_completed" && event.execution === ids.execution) {
              throw new Error("first publication unavailable");
            }
            return eventWriter.appendEvent(threadId, event);
          },
        },
        threadedInbox,
        eventSink,
      });
      expect(await failingFirst.sweep(1)).toBe(1);
      expect(
        (await repos.executionReports.findByExecution(ids.child, ids.execution))?.publication,
      ).toBe("pending");
      expect(await failingFirst.sweep(1)).toBe(1);
      expect(
        (await repos.executionReports.findByExecution(ids.child, ids.nextExecution))?.publication,
      ).toBe("published");
    });

    it("abandons publication after hard deletion without deleting retained child output", async () => {
      await terminal();
      await db.delete(schema.turnBlocks).where(eq(schema.turnBlocks.id, ids.card));
      await db.delete(schema.turns).where(eq(schema.turns.id, ids.parentTurn));
      await db.delete(schema.threads).where(eq(schema.threads.id, ids.parent));
      expect(
        (await repos.executionReports.findByExecution(ids.child, ids.execution))?.callerThreadId,
      ).toBeNull();
      expect(await publisher.publish(ids.child, ids.execution)).toBe("skipped");
      expect(
        (await repos.executionReports.findByExecution(ids.child, ids.execution))?.publication,
      ).toBe("skipped");
      expect(
        (await repos.executionReports.findByExecution(ids.child, ids.execution))?.summary,
      ).toBe("secret report body");
      expect(await repos.threads.findById(ids.child)).not.toBeNull();
    });

    it("parks a deleted caller, resumes on restoration, and repairs only after real run ownership is free", async () => {
      await db
        .update(schema.threads)
        .set({ deletedAt: new Date() })
        .where(eq(schema.threads.id, ids.parent));
      await terminal();
      expect(await publisher.publish(ids.child, ids.execution)).toBe("parked");
      expect(await publisher.sweep(1)).toBe(0);
      await db
        .update(schema.threads)
        .set({ deletedAt: null })
        .where(eq(schema.threads.id, ids.parent));
      expect(await publisher.sweep(1)).toBe(1);
      expect(
        (await repos.executionReports.findByExecution(ids.child, ids.execution))?.publication,
      ).toBe("published");
    });

    it("does not infer orphan death from a missing lease while the physical claim is held", async () => {
      const authority = createDrizzleRunAuthority(db, { holderId: "repair-test" });
      const repair = createOrphanReportRepair({
        repos,
        eventWriter,
        authority,
        threadLock,
        publisher,
        eventSink,
      });
      const held = await authority.acquire(ids.child, crypto.randomUUID());
      if (!held) throw new Error("failed to acquire test claim");
      await db
        .update(schema.threadRunLeases)
        .set({ expiresAt: new Date(0) })
        .where(eq(schema.threadRunLeases.threadId, ids.child));
      expect(await repair.sweep(1)).toBe(1);
      expect(
        (await repos.executionReports.findByExecution(ids.child, ids.execution))?.outcome,
      ).toBeNull();
      await authority.release(held);
      await repos.blocks.create({
        turnId: ids.execution,
        blockType: "text",
        sequence: 1,
        content: { text: "partial public text" },
      });
      expect(await repair.sweep(1)).toBe(1);
      expect(await repos.executionReports.findByExecution(ids.child, ids.execution)).toMatchObject({
        outcome: "failed",
        summary: "partial public text",
        publication: "published",
      });
      expect((await repos.turns.findById(ids.execution))?.status).toBe("error");
    });
  });
