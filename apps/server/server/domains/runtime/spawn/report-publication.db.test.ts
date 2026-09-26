/** PostgreSQL publication B and orphan recovery after durable terminal A. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionScenario } from "../../../test-support/execution-scenario.js";

const runDb = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;
const ids = {
  user: "00000000-0000-4000-8000-000000000be1",
  project: "00000000-0000-4000-8000-000000000be2",
  caller: "00000000-0000-4000-8000-000000000be3" as ThreadId,
  child: "00000000-0000-4000-8000-000000000be4" as ThreadId,
  callerTurn: "00000000-0000-4000-8000-000000000be5" as TurnId,
  childUserTurn: "00000000-0000-4000-8000-000000000be6" as TurnId,
  execution: "00000000-0000-4000-8000-000000000be7" as TurnId,
  card: "00000000-0000-4000-8000-000000000be8",
  root: "00000000-0000-4000-8000-000000000be9" as ThreadId,
  rootTurn: "00000000-0000-4000-8000-000000000bea" as TurnId,
  nextExecution: "00000000-0000-4000-8000-000000000beb" as TurnId,
  repairExecution: "00000000-0000-4000-8000-000000000bec" as TurnId,
};

if (!runDb || !databaseUrl) describe.skip("report publication and recovery (postgres)", () => {});
else
  describe("report publication and recovery (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { eq, sql } = await import("drizzle-orm");
    const { assertThrowawayDatabaseForRunDbTests } = await import(
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
    const { createDrizzleRunClaim } = await import("../adapters/drizzle-run-claim.js");
    const { createTestDrizzleDelivery } = await import(
      "../loop/__tests__/test-drizzle-delivery.js"
    );
    const { finalizeExecution } = await import("../loop/execution-finalizer.js");
    const { createReportPublisher } = await import("./report-publisher.js");
    const { bindAdmittedInvocationCard } = await import("./spawn-transcript.js");
    const { invocationCardProps } = await import("./spawn-output.js");
    const { createOrphanReportRepair } = await import("./orphan-report-repair.js");
    const { readThreadReport } = await import("./read-thread-report.js");

    assertThrowawayDatabaseForRunDbTests(databaseUrl);
    const db = createDb(databaseUrl, { max: 6 });
    const repos = createDrizzleRepositoriesForTest(db);
    const eventWriter = createDrizzleEventJournalWriter(db);
    const inbox = createDrizzleInbox(db);
    const threadLock = createDrizzleThreadLock(db);
    const eventSink = createInMemoryEventSink();
    const delivery = createTestDrizzleDelivery(db, { repos, eventWriter });
    const publisher = createReportPublisher({ repos, eventWriter, delivery, eventSink });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      const scenario = await executionScenario(db, ids);
      await scenario.admit();
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
          cause: { kind: "success", finishReason: "end_turn" },
        },
      );
    }

    it("publishes exact card replacement, metadata event and compact inbox once", async () => {
      await terminal();
      expect(await publisher.publish(ids.child, ids.execution)).toBe("published");
      expect(await publisher.publish(ids.child, ids.execution)).toBe("already");
      const card = await repos.blocks.findById(ids.card);
      expect(card).toMatchObject({ id: ids.card, turnId: ids.callerTurn, sequence: 7 });
      expect(card?.content).toMatchObject({
        kind: "helper-result",
        props: {
          status: "completed",
          parentTurnId: ids.callerTurn,
          toolCallId: "spawn-1",
          deliveryMode: "background_notification",
          execution: ids.execution,
        },
      });
      expect(JSON.stringify(card?.content)).not.toContain("secret report body");
      const events = await db
        .select()
        .from(schema.eventJournal)
        .where(eq(schema.eventJournal.threadId, ids.caller));
      expect(events.map((row) => row.eventType)).toEqual([
        "block.updated",
        "agent.run_completed",
        "inbox.changed",
      ]);
      expect(events[0]?.payload).toMatchObject({
        block: {
          id: ids.card,
          turnId: ids.callerTurn,
          sequence: 7,
          content: {
            kind: "helper-result",
            props: {
              parentTurnId: ids.callerTurn,
              toolCallId: "spawn-1",
              deliveryMode: "background_notification",
              execution: ids.execution,
            },
          },
        },
      });
      expect(JSON.stringify(events.map((row) => row.payload))).not.toContain("secret report body");
      const messages = await inbox.selectPending(ids.caller);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        provenance: { kind: "child", threadId: ids.child, reportId: ids.execution },
      });
      expect(JSON.stringify(messages)).toContain(
        `Subagent p1 finished (succeeded). Read its report with thread_report({\\"ref\\":\\"p1\\"}).`,
      );
      expect(JSON.stringify(messages)).not.toContain("secret report body");
      expect(
        (await repos.executionReports.findByExecution(ids.child, ids.execution))?.publication,
      ).toBe("published");
    });

    it("preserves JSON-text scalar payloads through terminal A, orphan repair, and exact report reads", async () => {
      const payload = '{"nested":[1,true,null,"text"]}';
      await repos.executionReports.captureOnce(ids.child, ids.execution, "return-json-text", {
        summary: "captured scalar",
        payload,
      });
      await finalizeExecution(
        { repos, eventWriter },
        {
          threadId: ids.child,
          assistantTurnId: ids.execution,
          cause: { kind: "success", finishReason: "end_turn" },
        },
      );
      const freshRepos = createDrizzleRepositoriesForTest(db);
      const finalized = await freshRepos.executionReports.findByExecution(ids.child, ids.execution);
      expect(finalized?.payload).toBe(payload);
      expect(
        await readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          repos: freshRepos,
        }),
      ).toMatchObject({ payload, summary: "captured scalar", outcome: "succeeded" });
      const terminal = {
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        outcome: "succeeded" as const,
        reason: null,
        source: "return_result" as const,
        summary: "captured scalar",
        payload,
        costMillicredits: 0,
      };
      expect(await freshRepos.executionReports.finalizeOnce(terminal)).toMatchObject({ payload });
      await expect(
        freshRepos.executionReports.finalizeOnce({
          ...terminal,
          payload: { nested: [1, true, null, "text"] },
        }),
      ).rejects.toThrow();
      expect(await publisher.publish(ids.child, ids.execution)).toBe("published");
      expect(await publisher.publish(ids.child, ids.execution)).toBe("already");

      await db.insert(schema.turns).values({
        id: ids.nextExecution,
        threadId: ids.child,
        parentTurnId: ids.childUserTurn,
        role: "assistant",
        origin: "assistant",
        status: "streaming",
      });
      const objectPayload = { nested: [1, true, null, "text"] };
      await repos.executionReports.admit({
        childThreadId: ids.child,
        assistantTurnId: ids.nextExecution,
        handle: "p1",
        origin: "thread_run",
        deliveryMode: "none",
        callerThreadId: null,
        callerTurnId: null,
        toolCallId: null,
        cardBlockId: null,
      });
      await repos.executionReports.captureOnce(ids.child, ids.nextExecution, "return-object", {
        summary: "object control",
        payload: objectPayload,
      });
      await finalizeExecution(
        { repos, eventWriter },
        {
          threadId: ids.child,
          assistantTurnId: ids.nextExecution,
          cause: { kind: "success", finishReason: "end_turn" },
        },
      );
      expect(
        (await freshRepos.executionReports.findByExecution(ids.child, ids.nextExecution))?.payload,
      ).toEqual(objectPayload);
      expect(
        await readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          repos: freshRepos,
        }),
      ).toHaveProperty("payload", objectPayload);

      await db.insert(schema.turns).values({
        id: ids.repairExecution,
        threadId: ids.child,
        parentTurnId: ids.childUserTurn,
        role: "assistant",
        origin: "assistant",
        status: "streaming",
      });
      await repos.executionReports.admit({
        childThreadId: ids.child,
        assistantTurnId: ids.repairExecution,
        handle: "p1",
        origin: "spawn",
        deliveryMode: "background_notification",
        callerThreadId: ids.caller,
        callerTurnId: ids.callerTurn,
        toolCallId: "spawn-repair",
        cardBlockId: null,
      });
      await repos.executionReports.captureOnce(ids.child, ids.repairExecution, "return-repair", {
        summary: "orphan scalar",
        payload,
      });
      const authority = createDrizzleRunClaim(db, { holderId: "json-roundtrip-repair" });
      const repair = createOrphanReportRepair({
        repos,
        eventWriter,
        authority,
        threadLock,
        publisher,
        eventSink,
      });
      expect(await repair.sweep(1)).toBe(1);
      const repaired = await freshRepos.executionReports.findByExecution(
        ids.child,
        ids.repairExecution,
      );
      expect(repaired).toMatchObject({
        outcome: "failed",
        reason: "orphaned",
        payload,
        publication: "published",
      });
      expect(await publisher.publish(ids.child, ids.repairExecution)).toBe("already");
    });

    it("round-trips every JsonValue payload type without changing scalar-string meaning", async () => {
      const values: Array<JsonValue | undefined> = [
        undefined,
        "ordinary text",
        '{"x":1}',
        "[1,2]",
        "123",
        "true",
        "null",
        '"inner string"',
        { x: 1 },
        [1, 2],
        123,
        true,
        null,
      ];
      for (const [index, payload] of values.entries()) {
        const execution = crypto.randomUUID() as TurnId;
        await db.insert(schema.turns).values({
          id: execution,
          threadId: ids.child,
          parentTurnId: ids.childUserTurn,
          role: "assistant",
          origin: "assistant",
          status: "complete",
        });
        await repos.executionReports.admit({
          childThreadId: ids.child,
          assistantTurnId: execution,
          handle: "p1",
          origin: "thread_run",
          deliveryMode: "none",
          callerThreadId: null,
          callerTurnId: null,
          toolCallId: null,
          cardBlockId: null,
        });
        const terminal = {
          childThreadId: ids.child,
          assistantTurnId: execution,
          outcome: "succeeded" as const,
          reason: null,
          source: "return_result" as const,
          summary: `payload ${index}`,
          ...(payload !== undefined ? { payload } : {}),
        };
        await repos.executionReports.finalizeOnce(terminal);
        const saved = await repos.executionReports.findByExecution(ids.child, execution);
        expect(saved?.payload).toEqual(payload);
        const result = await readThreadReport({
          callerThreadId: ids.caller,
          ref: "p1",
          repos,
        });
        if (payload === undefined) expect(result).not.toHaveProperty("payload");
        else expect(result).toHaveProperty("payload", payload);
        await expect(repos.executionReports.finalizeOnce(terminal)).resolves.toMatchObject(
          payload === undefined ? { summary: `payload ${index}` } : { payload },
        );
        if (payload === undefined) {
          await expect(
            repos.executionReports.finalizeOnce({ ...terminal, payload: null }),
          ).rejects.toThrow();
        }
      }
    });

    it("does not regress terminal status when admission binding arrives after publication", async () => {
      const originalCard = await repos.blocks.findById(ids.card);
      if (!originalCard) throw new Error("missing original card");
      await terminal();
      await publisher.publish(ids.child, ids.execution);
      const terminalCard = await repos.blocks.findById(ids.card);
      if (!terminalCard) throw new Error("missing terminal card");
      const priorEvents = await db
        .select()
        .from(schema.eventJournal)
        .where(eq(schema.eventJournal.threadId, ids.caller));
      await bindAdmittedInvocationCard({
        transcript: {
          persistence: { repos, eventWriter },
          threadId: ids.caller,
          turnId: ids.callerTurn,
          blockSeqRef: { value: 8 },
          allBlocks: [],
        },
        delivery,
        card: originalCard,
        props: invocationCardProps({
          agent: "critic",
          correlation: {
            parentTurnId: ids.callerTurn,
            toolCallId: "spawn-1",
            deliveryMode: "background_notification",
          },
          childThreadId: ids.child,
          execution: null,
        }),
        execution: ids.execution,
      });
      expect((await repos.blocks.findById(ids.card))?.content).toEqual(terminalCard.content);
      const afterEvents = await db
        .select()
        .from(schema.eventJournal)
        .where(eq(schema.eventJournal.threadId, ids.caller));
      expect(afterEvents).toHaveLength(priorEvents.length);
    });

    it("rolls back card, event, inbox and marker together on publication failure, then retries", async () => {
      await terminal();
      let wakes = 0;
      const transactionalInbox = createTestDrizzleDelivery(db, {
        repos,
        eventWriter,
        runStarter: {
          async start() {
            wakes++;
          },
        },
      });
      const failing = createReportPublisher({
        repos: {
          ...repos,
          executionReports: {
            ...repos.executionReports,
            async markPublished(...args) {
              await repos.executionReports.markPublished(...args);
              expect(
                (await repos.executionReports.findByExecution(ids.child, ids.execution))
                  ?.publication,
              ).toBe("published");
              expect(await inbox.selectPending(ids.caller)).toHaveLength(1);
              throw new Error("failure after publication marker");
            },
          },
        },
        eventWriter,
        delivery: transactionalInbox,
        eventSink,
      });
      await expect(failing.publish(ids.child, ids.execution)).rejects.toThrow(
        "failure after publication marker",
      );
      expect(wakes).toBe(0);
      const parentEvents = () =>
        db.select().from(schema.eventJournal).where(eq(schema.eventJournal.threadId, ids.caller));
      expect(await parentEvents()).toEqual([]);
      expect((await repos.blocks.findById(ids.card))?.content).toMatchObject({
        kind: "helper-result",
        props: { status: "running" },
      });
      expect(await inbox.selectPending(ids.caller)).toEqual([]);
      expect(
        (await repos.executionReports.findByExecution(ids.child, ids.execution))?.publication,
      ).toBe("pending");
      const recovered = createReportPublisher({
        repos,
        eventWriter,
        delivery: transactionalInbox,
        eventSink,
      });
      expect(await recovered.publish(ids.child, ids.execution)).toBe("published");
      expect(await recovered.publish(ids.child, ids.execution)).toBe("already");
      expect(wakes).toBe(1);
      expect(await inbox.selectPending(ids.caller)).toHaveLength(1);
      expect(
        (await parentEvents()).filter((event) => event.eventType === "agent.run_completed"),
      ).toHaveLength(1);
    });

    it("waits for the parent lock before locking the child report", async () => {
      await terminal();
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const parent = threadLock.withThreadLock(ids.caller, async () => {
        entered();
        await gate;
      });
      await reached;
      const publishing = publisher.publish(ids.child, ids.execution);
      try {
        await vi.waitUntil(async () => {
          const rows =
            await db.$client`select 1 from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())`;
          return rows.length > 0;
        });
        // A publisher that locked the report before waiting on its parent would make NOWAIT fail.
        await db.transaction((tx) =>
          tx.execute(
            sql`select assistant_turn_id from thread_execution_reports where assistant_turn_id=${ids.execution} for update nowait`,
          ),
        );
      } finally {
        release();
        await parent;
      }
      await expect(publishing).resolves.toBe("published");
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
      expect(await inbox.selectPending(ids.caller)).toHaveLength(1);
      const events = await db
        .select()
        .from(schema.eventJournal)
        .where(eq(schema.eventJournal.threadId, ids.caller));
      expect(events.map((row) => row.eventType)).toEqual(["agent.run_completed", "inbox.changed"]);
    });

    it("advances a bounded sweep past one failing publication", async () => {
      await terminal();
      await db.insert(schema.turns).values({
        id: ids.nextExecution,
        threadId: ids.child,
        parentTurnId: ids.execution,
        role: "assistant",
        origin: "assistant",
        status: "streaming",
      });
      await repos.executionReports.admit({
        childThreadId: ids.child,
        assistantTurnId: ids.nextExecution,
        handle: "p1",
        origin: "foreground_message",
        deliveryMode: "direct",
        callerThreadId: ids.caller,
        callerTurnId: ids.callerTurn,
        toolCallId: "message-2",
        cardBlockId: null,
      });
      await finalizeExecution(
        { repos, eventWriter },
        {
          threadId: ids.child,
          assistantTurnId: ids.nextExecution,
          cause: { kind: "success", finishReason: "end_turn" },
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
        delivery,
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
      await db.delete(schema.turns).where(eq(schema.turns.id, ids.callerTurn));
      await db.delete(schema.threads).where(eq(schema.threads.id, ids.caller));
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
        .where(eq(schema.threads.id, ids.caller));
      await terminal();
      expect(await publisher.publish(ids.child, ids.execution)).toBe("parked");
      expect(await publisher.sweep(1)).toBe(0);
      await db
        .update(schema.threads)
        .set({ deletedAt: null })
        .where(eq(schema.threads.id, ids.caller));
      expect(await publisher.sweep(1)).toBe(1);
      expect(
        (await repos.executionReports.findByExecution(ids.child, ids.execution))?.publication,
      ).toBe("published");
    });

    it("does not infer orphan death from a missing lease while the physical claim is held", async () => {
      const authority = createDrizzleRunClaim(db, { holderId: "repair-test" });
      const repair = createOrphanReportRepair({
        repos,
        eventWriter,
        authority,
        threadLock,
        publisher,
        eventSink,
      });
      const held = await authority.startExecution(ids.child, crypto.randomUUID());
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
