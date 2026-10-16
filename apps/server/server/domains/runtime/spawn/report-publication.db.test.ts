/** Consolidated test contracts; each block retains its original fixture scope. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { describe as __mergedSuite, afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { executionScenario } from "../../../test-support/execution-scenario.js";
import { journalEventsByThread } from "../../../test-support/journal-events.js";
import { releaseLeaseUnderLock } from "../../../test-support/release-lease.js";
import { processDetachedWork } from "../detached-work.js";
import { createTestDrizzleDelivery } from "../loop/__tests__/test-drizzle-delivery.js";

__mergedSuite("report-publication.db.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/spawn/report-publication.db.test.ts.
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

  if (!runDb || !databaseUrl)
    __mergedSuite.skip("report publication and recovery (postgres)", () => {});
  else
    __mergedSuite("report publication and recovery (postgres)", async () => {
      const schema = await import("@meridian/database/schema");
      const { eq, sql } = await import("drizzle-orm");
      const { assertThrowawayDatabaseForRunDbTests } = await import(
        "@meridian/database/__test-support__/db-fixtures"
      );
      const { deleteDrizzleRows } = await import("../../../test-support/drizzle-reset.js");
      const { createDrizzleRepositoriesForTest } = await import(
        "../../threads/adapters/drizzle/repositories.js"
      );
      const { CompactionMetadataCodec, createDrizzleEventJournalWriter } = await import(
        "../../threads/index.js"
      );
      const { createInMemoryEventSink } = await import("../../observability/index.js");
      const { createDrizzleInbox } = await import("../adapters/drizzle-inbox.js");
      const { createDrizzleThreadLock } = await import("../adapters/drizzle-thread-lock.js");
      const { createDrizzleRunClaim } = await import("../adapters/drizzle-run-claim.js");
      const { createTestDrizzleDelivery, createTestOrphanRepair } = await import(
        "../loop/__tests__/test-drizzle-delivery.js"
      );
      const { finalizeExecution } = await import("../loop/execution-finalizer.js");
      const { createOrphanReportRepair } = await import("./orphan-report-repair.js");
      const { createReportPublisher } = await import("./report-publisher.js");
      const { bindAdmittedInvocationCard } = await import("./spawn-transcript.js");
      const { invocationCardProps } = await import("./spawn-output.js");
      const { readThreadReport } = await import("./read-thread-report.js");
      assertThrowawayDatabaseForRunDbTests(databaseUrl);
      const { assertPublicationHooks, openAuditedDatabase } = await import(
        "../../../test-support/run-state-publication.js"
      );
      // Publication pins run in a database this suite owns and drops.
      const audited = await openAuditedDatabase(databaseUrl, { max: 6 });
      const db = audited.db;
      const repos = createDrizzleRepositoriesForTest(db);
      const eventWriter = createDrizzleEventJournalWriter(db);
      const inbox = createDrizzleInbox(db);
      const threadLock = createDrizzleThreadLock(db, eventWriter);
      const eventSink = createInMemoryEventSink();
      const delivery = createTestDrizzleDelivery(db, { repos, eventWriter });
      const publisher = createReportPublisher({ repos, eventWriter, delivery, eventSink });
      beforeEach(async () => {
        await deleteDrizzleRows(db, [schema.users]);
        const scenario = await executionScenario(db, ids);
        await scenario.admit();
      });
      afterAll(() => audited.close());
      // Publication pins: no input write without a record, and the last record equals the rows.
      afterEach(() => assertPublicationHooks(db));
      async function terminal() {
        await repos.executionReports.captureOnce(ids.child, ids.execution, "return-1", {
          summary: "secret report body",
          payload: { private: "detail" },
        });
        await finalizeExecution(
          { repos, eventWriter },
          {
            threadId: ids.child,
            turnId: ids.execution,
            cause: { kind: "success", finishReason: "end_turn" },
          },
        );
      }
      it.each([
        "child-report",
        "child-placeholder",
      ] as const)("preserves a newer orphan receipt after a stale %s candidate", async (lane) => {
        // Capture A before another worker finishes it and admits B.
        const staleReports = (await repos.executionReports.listUnfinalized(100)).filter(
          (candidate) => candidate.childThreadId === ids.child,
        );
        const placeholder =
          lane === "child-placeholder"
            ? await repos.turns.create({
                threadId: ids.child,
                prevTurnId: ids.execution,
                role: "compaction",
                origin: "system",
                status: "pending",
              })
            : null;
        const stalePlaceholders = placeholder
          ? (await repos.turns.listPendingPlaceholders(100)).filter(
              (candidate) => candidate.id === placeholder.id,
            )
          : [];
        await terminal();
        if (placeholder)
          await finalizeExecution(
            { repos, eventWriter },
            {
              threadId: ids.child,
              turnId: placeholder.id,
              cause: { kind: "failed", reason: "orphaned", error: "Worker A stopped" },
            },
          );
        const authority = createDrizzleRunClaim(db);
        const runDelivery = createTestDrizzleDelivery(db, {
          repos,
          eventWriter,
          runClaim: authority,
        });
        const message = await runDelivery.enqueue({
          threadId: ids.child,
          intent: "message",
          provenance: { kind: "agent", threadId: ids.caller },
          body: { kind: "text", text: "Already adopted by B" },
          idempotencyKey: crypto.randomUUID(),
        });
        const next = await repos.turns.create({
          threadId: ids.child,
          prevTurnId: placeholder?.id ?? ids.execution,
          role: "assistant",
          origin: "assistant",
          status: "streaming",
        });
        await repos.executionReports.admit({
          childThreadId: ids.child,
          executionTurnId: next.id,
          handle: "p1",
          origin: "message",
          deliveryMode: "background_notification",
          callerThreadId: ids.caller,
          callerTurnId: ids.callerTurn,
          toolCallId: "message-B",
          cardBlockId: null,
        });
        await db.insert(schema.threadRunLeases).values({
          threadId: ids.child,
          executionId: "dead-B",
          holderId: "worker-B",
          turnId: next.id,
          boundTurnIds: [next.id],
          adoptedMessageIds: [message.id],
          expiresAt: new Date(Date.now() + 60000),
        });
        let reportPage = lane === "child-report" ? staleReports : [];
        let placeholderPage = stalePlaceholders;
        const repair = createOrphanReportRepair({
          repos: {
            ...repos,
            turns: {
              ...repos.turns,
              async listUnsettledPrimaryTurns() {
                return [];
              },
              async listPendingPlaceholders() {
                return placeholderPage;
              },
            },
            executionReports: {
              ...repos.executionReports,
              async listUnfinalized() {
                return reportPage;
              },
            },
          },
          inbox: runDelivery,
          authority,
          eventWriter,
          settleStaleExecution: runDelivery.settleStaleExecution,
          retireOrphanedReply: runDelivery.retireOrphanedReply,
          clearOrphanedTurn: runDelivery.clearOrphanedTurn,
          publisher: {
            async publish() {
              return "already" as const;
            },
          },
          eventSink,
        });
        await repair.sweep(10);
        expect(await repos.turns.findById(next.id)).toMatchObject({
          status: "streaming",
        });
        expect(await db.select().from(schema.threadRunLeases)).toMatchObject([
          {
            executionId: "dead-B",
            turnId: next.id,
            adoptedMessageIds: [message.id],
          },
        ]);
        placeholderPage = [];
        reportPage = [{ childThreadId: ids.child, executionTurnId: next.id }];
        await repair.sweep(10);
        expect(await repos.turns.findById(next.id)).toMatchObject({ status: "error" });
        expect(await repos.executionReports.findByExecution(ids.child, next.id)).toMatchObject({
          outcome: "failed",
          reason: "orphaned",
        });
        expect(await db.select().from(schema.threadRunLeases)).toEqual([]);
        expect(await runDelivery.selectPending(ids.child)).toEqual([]);
        const followup = await authority.startExecution(ids.child, "followup", async () => {});
        expect(followup).not.toBeNull();
        if (followup) await authority.release(followup);
      });
      it("publishes exact card replacement, metadata event and compact inbox once", async () => {
        await terminal();
        expect(await publisher.publish(ids.child, ids.execution)).toBe("published");
        expect(await publisher.publish(ids.child, ids.execution)).toBe("already");
        const card = await repos.blocks.findById(ids.card);
        expect(card).toMatchObject({
          id: ids.card,
          turnId: ids.callerTurn,
          sequence: 7,
        });
        expect(card?.content).toMatchObject({
          kind: "helper-result",
          props: {
            outcome: "succeeded",
            parentTurnId: ids.callerTurn,
            toolCallId: "spawn-1",
            deliveryMode: "background_notification",
            execution: ids.execution,
          },
        });
        expect(JSON.stringify(card?.content)).not.toContain("secret report body");
        const events = await journalEventsByThread(db, ids.caller);
        expect(events.map((row) => row.eventType)).toEqual([
          "block.updated",
          "agent.run_completed",
          "run_state.changed",
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
        expect(JSON.stringify(events.map((row) => row.payload))).not.toContain(
          "secret report body",
        );
        const messages = await inbox.selectPending(ids.caller);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          provenance: {
            kind: "child",
            threadId: ids.child,
            reportId: ids.execution,
            agentName: "critic",
          },
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
            turnId: ids.execution,
            cause: { kind: "success", finishReason: "end_turn" },
          },
        );
        const freshRepos = createDrizzleRepositoriesForTest(db);
        const finalized = await freshRepos.executionReports.findByExecution(
          ids.child,
          ids.execution,
        );
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
          executionTurnId: ids.execution,
          outcome: "succeeded" as const,
          reason: null,
          source: "return_result" as const,
          summary: "captured scalar",
          payload,
          costMillicredits: 0,
        };
        expect(await freshRepos.executionReports.finalizeOnce(terminal)).toMatchObject({
          payload,
        });
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
          position: 3,
          parentTurnId: ids.childUserTurn,
          role: "assistant",
          origin: "assistant",
          status: "streaming",
        });
        const objectPayload = { nested: [1, true, null, "text"] };
        await repos.executionReports.admit({
          childThreadId: ids.child,
          executionTurnId: ids.nextExecution,
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
            turnId: ids.nextExecution,
            cause: { kind: "success", finishReason: "end_turn" },
          },
        );
        expect(
          (await freshRepos.executionReports.findByExecution(ids.child, ids.nextExecution))
            ?.payload,
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
          position: 4,
          parentTurnId: ids.childUserTurn,
          role: "assistant",
          origin: "assistant",
          status: "streaming",
        });
        await repos.executionReports.admit({
          childThreadId: ids.child,
          executionTurnId: ids.repairExecution,
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
        const repair = createTestOrphanRepair(db, {
          inbox: createDrizzleInbox(db),
          repos,
          eventWriter,
          authority,
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
      it("does not regress terminal status when admission binding arrives after publication", async () => {
        const originalCard = await repos.blocks.findById(ids.card);
        if (!originalCard) throw new Error("missing original card");
        await terminal();
        await publisher.publish(ids.child, ids.execution);
        const terminalCard = await repos.blocks.findById(ids.card);
        if (!terminalCard) throw new Error("missing terminal card");
        const priorEvents = await journalEventsByThread(db, ids.caller);
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
            agentName: "critic",
            correlation: {
              parentTurnId: ids.callerTurn,
              toolCallId: "spawn-1",
              deliveryMode: "background_notification",
            },
            childThreadId: ids.child,
            execution: null,
            startedAt: "2026-01-01T00:00:00.000Z",
            terminalAt: null,
          }),
          execution: ids.execution,
          admittedAt: "2026-01-01T00:00:00.000Z",
        });
        expect((await repos.blocks.findById(ids.card))?.content).toEqual(terminalCard.content);
        const afterEvents = await journalEventsByThread(db, ids.caller);
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
        const parentEvents = () => journalEventsByThread(db, ids.caller);
        expect(await parentEvents()).toEqual([]);
        expect((await repos.blocks.findById(ids.card))?.content).toMatchObject({
          kind: "helper-result",
          props: { execution: null, terminalAt: null },
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
              sql`select execution_turn_id from thread_execution_reports where execution_turn_id=${ids.execution} for update nowait`,
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
        const events = await journalEventsByThread(db, ids.caller);
        expect(events.map((row) => row.eventType)).toEqual([
          "agent.run_completed",
          "run_state.changed",
        ]);
      });
      it("advances a bounded sweep past one failing publication", async () => {
        await terminal();
        await db.insert(schema.turns).values({
          id: ids.nextExecution,
          threadId: ids.child,
          position: 3,
          parentTurnId: ids.execution,
          role: "assistant",
          origin: "assistant",
          status: "streaming",
        });
        await repos.executionReports.admit({
          childThreadId: ids.child,
          executionTurnId: ids.nextExecution,
          handle: "p1",
          origin: "message",
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
            turnId: ids.nextExecution,
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
        const repair = createTestOrphanRepair(db, {
          inbox: createDrizzleInbox(db),
          repos,
          eventWriter,
          authority,
          publisher,
          eventSink,
        });
        const held = await authority.startExecution(ids.child, crypto.randomUUID(), async () => {});
        if (!held) throw new Error("failed to acquire test claim");
        await db
          .update(schema.threadRunLeases)
          .set({ expiresAt: new Date(0) })
          .where(eq(schema.threadRunLeases.threadId, ids.child));
        // The unsettled turn and the expired lease are both candidates; neither is
        // settled while the claim is held.
        expect(await repair.sweep(1)).toBe(2);
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
        expect(
          await repos.executionReports.findByExecution(ids.child, ids.execution),
        ).toMatchObject({
          outcome: "failed",
          summary: "partial public text",
          publication: "published",
        });
        expect((await repos.turns.findById(ids.execution))?.status).toBe("error");
      });
      it("retires a crashed child's adopted parent message after publishing one failure report", async () => {
        const adopted = await delivery.enqueue({
          threadId: ids.child,
          intent: "message",
          provenance: { kind: "agent", threadId: ids.caller },
          body: { kind: "text", text: "Review this scene." },
          idempotencyKey: "crashed-child-adopted-parent-message",
        });
        await db.insert(schema.threadRunLeases).values({
          threadId: ids.child,
          executionId: "dead-child-run",
          turnId: ids.execution,
          boundTurnIds: [ids.execution],
          adoptedMessageIds: [adopted.id],
          holderId: "dead-worker",
          phase: "generating",
          expiresAt: new Date(0),
        });
        const authority = createDrizzleRunClaim(db, { holderId: "child-crash-repair" });
        const repair = createTestOrphanRepair(db, {
          inbox,
          repos,
          eventWriter,
          authority,
          publisher,
          eventSink,
          retireOrphanedReply: delivery.retireOrphanedReply,
        });
        expect(await repair.sweep(10)).toBeGreaterThanOrEqual(1);
        expect(await repos.turns.findById(ids.execution)).toMatchObject({
          status: "error",
          error: "This response failed.",
        });
        expect(
          (await journalEventsByThread(db, ids.child)).find(
            (event) => event.eventType === "turn.error",
          )?.payload,
        ).toMatchObject({
          error: {
            message: "Child execution stopped before terminal completion",
            details: { reason: "orphaned" },
          },
        });
        expect(await inbox.selectPending(ids.child)).toEqual([]);
        // The repair lane settles the expired row too: a lease no turn carries is deleted.
        expect(await db.select().from(schema.threadRunLeases)).toEqual([]);
        expect(
          (await journalEventsByThread(db, ids.caller)).filter(
            (event) => event.eventType === "agent.run_completed",
          ),
        ).toHaveLength(1);
        expect(await repair.sweep(10)).toBe(0);
        expect(
          (await journalEventsByThread(db, ids.caller)).filter(
            (event) => event.eventType === "agent.run_completed",
          ),
        ).toHaveLength(1);
      });
      it("repairs indexed pending placeholders for primary and child threads, then publishes the child report", async () => {
        eventSink.clear();
        const primaryC = await repos.turns.create({
          threadId: ids.root,
          prevTurnId: ids.rootTurn,
          role: "compaction",
          origin: "system",
          status: "pending",
        });
        const childC = await repos.turns.create({
          threadId: ids.child,
          prevTurnId: ids.execution,
          role: "compaction",
          origin: "system",
          status: "pending",
        });
        await repos.executionReports.captureOnce(ids.child, ids.execution, "candidate-before-c", {
          summary: "Captured candidate is not an orphan report.",
          payload: { partial: true },
        });
        for (const [turnId, millicredits] of [
          [ids.execution, "13"],
          [childC.id, "5"],
        ] as const) {
          await repos.modelResponses.create({
            turnId,
            sequence: 0,
            provider: "test",
            model: "fixture",
            millicredits,
            priceSource: "unknown",
            requestMessageCount: 1,
            predictedCacheState: "cold",
            predictedCacheReason: "no_response",
          });
        }
        const authority = createDrizzleRunClaim(db, { holderId: "placeholder-scan" });
        const repair = createTestOrphanRepair(db, {
          inbox: createDrizzleInbox(db),
          repos,
          eventWriter,
          authority,
          publisher,
          eventSink,
        });
        expect(await repair.sweep(10)).toBe(2);
        expect(eventSink.events.filter((event) => event.name === "placeholder.failed")).toEqual([]);
        for (const turnId of [primaryC.id, childC.id]) {
          const repaired = await repos.turns.findById(turnId);
          expect(repaired).toMatchObject({
            status: "error",
            error: "This conversation couldn't be compacted. Try again.",
          });
          expect(CompactionMetadataCodec.parse(repaired?.metadata)).toMatchObject({
            reason: "interrupted",
            phase: "recovery",
          });
        }
        expect(
          await repos.executionReports.findByExecution(ids.child, ids.execution),
        ).toMatchObject({
          outcome: "failed",
          reason: "orphaned",
          source: "empty",
          summary: "",
          terminalTurnId: childC.id,
          costMillicredits: 18,
          publication: "published",
        });
        expect(
          await repos.executionReports.findByExecution(ids.child, ids.execution),
        ).not.toHaveProperty("payload");
        expect(await publisher.sweep(10)).toBe(0);
        expect((await repos.blocks.findById(ids.card))?.content).toMatchObject({
          props: { outcome: "failed", execution: ids.execution },
        });
      });
      it("stops the orphan report walk at a newer compaction execution selector", async () => {
        const c = await repos.turns.create({
          threadId: ids.child,
          prevTurnId: ids.execution,
          role: "compaction",
          origin: "system",
          status: "pending",
        });
        await repos.executionReports.admit({
          childThreadId: ids.child,
          executionTurnId: c.id,
          handle: "p1",
          origin: "thread_run",
          deliveryMode: "none",
          callerThreadId: null,
          callerTurnId: null,
          toolCallId: null,
          cardBlockId: null,
        });
        const authority = createDrizzleRunClaim(db, { holderId: "placeholder-report-walk" });
        const repair = createTestOrphanRepair(db, {
          inbox: createDrizzleInbox(db),
          repos,
          eventWriter,
          authority,
          publisher,
          eventSink,
        });
        await repair.sweep(10);
        expect(await repos.executionReports.findByExecution(ids.child, c.id)).toMatchObject({
          outcome: "failed",
          reason: "orphaned",
          terminalTurnId: c.id,
        });
        expect(
          await repos.executionReports.findByExecution(ids.child, ids.execution),
        ).toMatchObject({
          outcome: "failed",
          reason: "orphaned",
          terminalTurnId: ids.execution,
        });
      });
      it("keeps E1 on streaming A1 before M2 and a completed C2 selector with B2", async () => {
        const m2 = await repos.turns.create({
          threadId: ids.child,
          prevTurnId: ids.execution,
          role: "user",
          origin: "writer",
          status: "complete",
        });
        const c2 = await repos.turns.create({
          threadId: ids.child,
          prevTurnId: m2.id,
          role: "compaction",
          origin: "system",
          status: "complete",
          compactionModel: "test-model",
        });
        const b2 = await repos.turns.create({
          threadId: ids.child,
          prevTurnId: c2.id,
          role: "assistant",
          origin: "assistant",
          status: "complete",
        });
        await repos.executionReports.admit({
          childThreadId: ids.child,
          executionTurnId: c2.id,
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
          executionTurnId: c2.id,
          terminalTurnId: b2.id,
          outcome: "succeeded",
          reason: null,
          source: "empty",
          summary: "",
        });
        const repair = createTestOrphanRepair(db, {
          inbox: createDrizzleInbox(db),
          repos,
          eventWriter,
          authority: createDrizzleRunClaim(db, { holderId: "exact-report-walk" }),
          publisher,
          eventSink,
        });
        await repair.sweep(10);
        expect(await repos.turns.findById(ids.execution)).toMatchObject({
          status: "error",
        });
        expect(
          await repos.executionReports.findByExecution(ids.child, ids.execution),
        ).toMatchObject({
          outcome: "failed",
          reason: "orphaned",
          terminalTurnId: ids.execution,
        });
        expect(await repos.executionReports.findByExecution(ids.child, c2.id)).toMatchObject({
          outcome: "succeeded",
          terminalTurnId: b2.id,
        });
      });
      it("publishes a child run-start placeholder failure once after releasing its lock", async () => {
        const c = await repos.turns.create({
          threadId: ids.child,
          prevTurnId: ids.execution,
          role: "compaction",
          origin: "system",
          status: "pending",
        });
        const authority = createDrizzleRunClaim(db, { holderId: "child-placeholder-run-start" });
        const runDelivery = createTestDrizzleDelivery(db, {
          repos,
          eventWriter,
          runClaim: authority,
          async publishFinalizedReports(reports) {
            for (const report of reports)
              await publisher.publish(report.childThreadId, report.executionTurnId);
          },
        });
        const message = await runDelivery.enqueue({
          threadId: ids.child,
          intent: "message",
          provenance: { kind: "writer", actorId: ids.user },
          body: { kind: "text", text: "Continue after the interrupted compaction." },
          idempotencyKey: "child-run-start-after-orphaned-c",
        });
        await repos.turns.create({
          id: message.id as TurnId,
          threadId: ids.child,
          prevTurnId: c.id,
          role: "user",
          origin: "writer",
          status: "complete",
        });
        const lease = await authority.startExecution(ids.child, crypto.randomUUID(), () =>
          runDelivery.settleStaleExecution(ids.child),
        );
        if (!lease) throw new Error("failed to acquire child run claim");
        const repaired = await repos.turns.findById(c.id);
        expect(repaired).toMatchObject({
          status: "error",
          error: "This conversation couldn't be compacted. Try again.",
        });
        expect(CompactionMetadataCodec.parse(repaired?.metadata)).toMatchObject({
          reason: "interrupted",
          phase: "recovery",
        });
        const assistantId = crypto.randomUUID() as TurnId;
        try {
          await runDelivery.adoptBatch(lease, async (selection) => {
            expect(selection.batch.map(({ id }) => id)).toEqual([message.id]);
            return {
              value: assistantId,
              turnId: assistantId,
              turnKind: "assistant",
              messageIds: [message.id],
              persist: async () => {
                await repos.turns.create({
                  id: assistantId,
                  threadId: ids.child,
                  prevTurnId: message.id as TurnId,
                  role: "assistant",
                  origin: "assistant",
                  status: "streaming",
                });
              },
            };
          });
        } finally {
          await releaseLeaseUnderLock(db, authority, lease);
        }
        expect(
          await repos.executionReports.findByExecution(ids.child, ids.execution),
        ).toMatchObject({
          outcome: "failed",
          reason: "orphaned",
          terminalTurnId: c.id,
          publication: "published",
        });
        expect(await publisher.sweep(10)).toBe(0);
        const parentEvents = await journalEventsByThread(db, ids.caller);
        expect(
          parentEvents.filter((event) => event.eventType === "agent.run_completed"),
        ).toHaveLength(1);
      });
    });
});

__mergedSuite("execution-finalizer.db.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/loop/execution-finalizer.db.test.ts.
  const runDb = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

  const databaseUrl = process.env.DATABASE_URL;

  const ids = {
    user: "00000000-0000-4000-8000-000000000ad1",
    project: "00000000-0000-4000-8000-000000000ad2",
    caller: "00000000-0000-4000-8000-000000000ad3" as ThreadId,
    child: "00000000-0000-4000-8000-000000000ad4" as ThreadId,
    callerTurn: "00000000-0000-4000-8000-000000000ad5" as TurnId,
    childUserTurn: "00000000-0000-4000-8000-000000000ad6" as TurnId,
    execution: "00000000-0000-4000-8000-000000000ad7" as TurnId,
  };

  if (!runDb || !databaseUrl) __mergedSuite.skip("execution terminal A (postgres)", () => {});
  else
    __mergedSuite("execution terminal A (postgres)", async () => {
      const { createDb } = await import("@meridian/database");
      const schema = await import("@meridian/database/schema");
      const { assertThrowawayDatabaseForRunDbTests } = await import(
        "@meridian/database/__test-support__/db-fixtures"
      );
      const { deleteDrizzleRows } = await import("../../../test-support/drizzle-reset.js");
      const { createDrizzleRepositoriesForTest } = await import(
        "../../threads/adapters/drizzle/repositories.js"
      );
      const { createDrizzleEventJournalWriter, createDrizzleEventJournalReader } = await import(
        "../../threads/index.js"
      );
      const { finalizeExecution } = await import("../loop/execution-finalizer.js");
      assertThrowawayDatabaseForRunDbTests(databaseUrl);
      const db = createDb(databaseUrl, { max: 6 });
      const repos = createDrizzleRepositoriesForTest(db);
      const eventWriter = createDrizzleEventJournalWriter(db);
      beforeEach(async () => {
        await deleteDrizzleRows(db, [schema.users]);
        const scenario = await executionScenario(db, ids);
        await scenario.admit();
      });
      afterAll(async () => {
        await db.close();
      });
      it.each([
        "tool",
        "rollback",
      ] as const)("splits an ordered mixed batch at %s with one lease and report", async (boundary) => {
        const { createLockedDrizzleInbox } = await import("../../../test-support/locked-inbox.js");
        const { createDrizzleRunClaim } = await import("../adapters/drizzle-run-claim.js");
        const { persistWriterEnqueue } = await import("../loop/writer-enqueue.js");
        const { createRuntimeHarness } = await import("../loop/__tests__/runtime-harness.js");
        const { readThreadReport } = await import("../spawn/read-thread-report.js");
        const { readRunStateAtHead } = await import("../adapters/drizzle-run-state.js");
        const { createInertGateway } = await import("../loop/__tests__/test-gateway.js");
        const inbox = createLockedDrizzleInbox(db);
        const authority = createDrizzleRunClaim(db);
        const producer = createTestDrizzleDelivery(db, {
          repos,
          eventWriter,
          runClaim: authority,
        });
        const controller = new AbortController();
        const requests: import("../gateway/index.js").GenerateRequest[] = [];
        const messageIds: string[] = [];
        let selector: TurnId;
        let terminal: TurnId | null = null;
        let splitState: unknown;
        const cleanupWakes: ThreadId[] = [];
        let failSplit = boundary === "rollback";
        const splitWriter: typeof eventWriter = {
          async appendEvent(threadId, event) {
            if (
              failSplit &&
              selector &&
              event.type === "turn.created" &&
              event.turn.role === "assistant" &&
              event.turn.id !== selector
            ) {
              failSplit = false;
              throw new Error("split journal failed");
            }
            return eventWriter.appendEvent(threadId, event);
          },
        };
        const harness = createRuntimeHarness({
          backgroundTasks: processDetachedWork,
          repos,
          eventWriter: splitWriter,
          ...(boundary === "rollback"
            ? {
                wakeIfRunnable: async (threadId: ThreadId) => {
                  cleanupWakes.push(threadId);
                },
              }
            : {}),
          delivery: createTestDrizzleDelivery(db, {
            repos,
            eventWriter: splitWriter,
            runClaim: authority,
          }),
          runClaim: authority,
          boundThreads: () => [ids.caller, ids.child],
          gateway: {
            ...createInertGateway("gpt-4.1-mini"),
            async *stream(request) {
              requests.push(request);
              if (requests.length === 1) {
                const child = await producer.enqueue({
                  threadId: ids.child,
                  intent: "message",
                  provenance: {
                    kind: "child",
                    threadId: ids.caller,
                    reportId: ids.callerTurn,
                    handle: "p1",
                    outcome: "succeeded",
                    agentName: "Subagent",
                  },
                  body: { kind: "text", text: "child notification" },
                  idempotencyKey: "child",
                });
                messageIds.push(child.id);
                const writerId = crypto.randomUUID();
                await persistWriterEnqueue({
                  persistence: { repos, eventWriter },
                  hub: {
                    async headSeq() {
                      return 0n;
                    },
                  },
                  delivery: producer,
                  threadId: ids.child,
                  userTurnId: writerId,
                  userBlocks: [{ type: "text", text: "writer steer" }],
                  draft: {
                    id: writerId,
                    threadId: ids.child,
                    intent: "message",
                    provenance: { kind: "writer", actorId: ids.user },
                    body: { kind: "text", text: "writer steer" },
                    idempotencyKey: "writer",
                  },
                  settle: async () => true,
                });
                messageIds.push(writerId);
                // Replay cannot duplicate the queue row or its eventual turn.
                await producer.enqueue({
                  threadId: ids.child,
                  intent: "message",
                  provenance: { kind: "writer", actorId: ids.user },
                  body: { kind: "text", text: "writer steer" },
                  idempotencyKey: "writer",
                });
              } else {
                terminal = await authority.readRunningTurnId(ids.child);
                splitState = {
                  run: await authority.holder(ids.child),
                  report: await repos.executionReports.findByExecution(ids.child, selector),
                  lookup: await readThreadReport({
                    callerThreadId: ids.caller,
                    ref: "p1",
                    repos,
                  }),
                  pending: (await readRunStateAtHead(db, ids.child)).items,
                };
              }
              yield {
                type: "end",
                result: {
                  content: [
                    {
                      type: "text",
                      text: requests.length === 1 ? "before steer" : "after steer",
                    },
                  ],
                  toolCalls:
                    requests.length === 1 && boundary === "tool"
                      ? [{ id: "tool-1", name: "unregistered", arguments: {} }]
                      : [],
                  finishReason:
                    requests.length === 1 && boundary === "tool" ? "tool_use" : "end_turn",
                  usage: { inputTokens: 1000000, outputTokens: 1000000 },
                  provider: "openai",
                  model: "gpt-4.1-mini",
                },
              };
            },
          },
        });
        await harness.creditLedger.grant({
          userId: ids.user,
          source: "manual",
          amountMillicredits: "1000000",
          reason: "split",
        });
        {
          const run = await harness.orchestrator.prepare({
            threadId: ids.child,
            userText: "start",
            signal: controller.signal,
            onCurrentTurnChanged: ({ id }) => {
              terminal = id;
            },
          });
          selector = run.executionTurnId;
          const outcome = await run.execute();
          const events = (await createDrizzleEventJournalReader(db).listByThread(ids.child)).map(
            (entry) => entry.payload,
          );
          expect(outcome.status).toBe(boundary === "rollback" ? "error" : "complete");
          const turns = await repos.turns.listByThread(ids.child);
          if (boundary === "rollback") {
            // The fixture gates the cleanup wake: assert the released lease and pending
            // messages at that barrier, then drive the successor separately.
            await processDetachedWork.drain();
            expect(cleanupWakes).toEqual([ids.child]);
            expect(terminal).toBeNull();
            expect((await repos.turns.findById(selector))?.status).toBe("error");
            expect(await repos.executionReports.findByExecution(ids.child, selector)).toMatchObject(
              {
                terminalTurnId: selector,
                outcome: "failed",
                summary: "before steer",
              },
            );
            expect(events.filter((event) => event.type === "turn.completed")).toEqual([]);
            expect((await inbox.selectPending(ids.child)).map((message) => message.id)).toEqual(
              messageIds,
            );
            expect(await authority.holder(ids.child)).toBeNull();
            const { createWakeIfRunnable } = await import("../loop/wake-if-runnable.js");
            const wake = createWakeIfRunnable({
              delivery: harness.deps.delivery,
              runStarter: {
                async start(threadId) {
                  const successor = await harness.orchestrator.prepare({ threadId, drain: true });
                  expect(successor.executionId).not.toBe(run.executionId);
                  expect(await authority.holder(threadId)).toBe(successor.executionId);
                  expect((await successor.execute()).status).toBe("complete");
                },
              },
            });
            while (cleanupWakes.length) {
              const threadId = cleanupWakes.shift();
              if (threadId) await wake(threadId);
              await processDetachedWork.drain();
            }
            expect(await inbox.selectPending(ids.child)).toEqual([]);
            expect(await authority.holder(ids.child)).toBeNull();
            return;
          }
          const b = turns.find((turn) => turn.id === terminal);
          if (!terminal) throw new Error("expected split terminal turn");
          expect(b?.parentTurnId).toBe(messageIds[1]);
          expect(turns.find((turn) => turn.id === messageIds[1])?.parentTurnId).toBe(messageIds[0]);
          expect(turns.find((turn) => turn.id === messageIds[0])?.parentTurnId).toBe(selector);
          expect(turns.filter((turn) => messageIds.includes(turn.id))).toHaveLength(2);
          expect((await repos.turns.findById(selector))?.status).toBe("complete");
          const report = await repos.executionReports.findByExecution(ids.child, selector);
          expect(report).toMatchObject({
            executionTurnId: selector,
            terminalTurnId: terminal,
            outcome: "succeeded",
            summary: "after steer",
          });
          expect(await repos.executionReports.findByExecution(ids.child, terminal)).toBeNull();
          const costs = await Promise.all(
            [selector, terminal].map((id) => repos.modelResponses.listByTurn(id)),
          );
          expect(report?.costMillicredits).toBe(
            costs.flat().reduce((sum, response) => sum + Number(response.millicredits), 0),
          );
          expect(await inbox.selectPending(ids.child)).toEqual([]);
          expect(await authority.holder(ids.child)).toBeNull();
          expect(events.filter((event) => event.type === "turn.completed").length).toBe(2);
          {
            expect(splitState).toMatchObject({
              run: run.executionId,
              report: { outcome: null, terminalTurnId: null },
              lookup: { status: "unavailable" },
              pending: [{ deliveryState: "awaiting_run" }, { deliveryState: "awaiting_run" }],
            });
            const text = JSON.stringify(requests[1]?.messages);
            expect(text.indexOf("before steer")).toBeLessThan(text.indexOf("child notification"));
            expect(text.indexOf("child notification")).toBeLessThan(text.indexOf("writer steer"));
          }
        }
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
                turnId: ids.execution,
                cause: {
                  kind: "failed",
                  reason: "budget",
                  error: "budget exhausted",
                },
              },
            );
            throw new Error("outer rollback");
          }),
        ).rejects.toThrow("outer rollback");
        expect((await repos.turns.findById(ids.execution))?.status).toBe("streaming");
        expect(
          await repos.executionReports.findByExecution(ids.child, ids.execution),
        ).toMatchObject({
          capture: { summary: "candidate" },
          outcome: null,
          publication: "none",
        });
        const first = await finalizeExecution(
          { repos, eventWriter },
          {
            threadId: ids.child,
            turnId: ids.execution,
            cause: {
              kind: "failed",
              reason: "budget",
              error: "budget exhausted",
            },
          },
        );
        expect(first.events.map((event) => event.type)).toEqual(["turn.error"]);
        expect(first.events[0]).toMatchObject({
          type: "turn.error",
          error: { details: { reason: "budget" } },
        });
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
            turnId: ids.execution,
            cause: {
              kind: "failed",
              reason: "budget",
              error: "budget exhausted",
            },
          },
        );
        expect(replay.events).toEqual([]);
        expect(replay.report).toMatchObject({
          outcome: "failed",
          publication: "pending",
        });
      });
      it("selects ordered public blocks of the final persisted response and its own accounting", async () => {
        const earlier = await repos.modelResponses.create({
          turnId: ids.execution,
          sequence: 0,
          provider: "test",
          model: "test-model",
          priceSource: "unknown",
          millicredits: "3",
          requestMessageCount: 1,
          predictedCacheState: "cold",
          predictedCacheReason: "facts_unavailable",
        });
        const final = await repos.modelResponses.create({
          turnId: ids.execution,
          sequence: 1,
          provider: "test",
          model: "test-model",
          priceSource: "unknown",
          millicredits: "4",
          requestMessageCount: 1,
          predictedCacheState: "cold",
          predictedCacheReason: "facts_unavailable",
        });
        await repos.blocks.create({
          turnId: ids.execution,
          responseId: earlier.row.id,
          blockType: "text",
          sequence: 1,
          content: "older public text",
        });
        await repos.blocks.create({
          turnId: ids.execution,
          responseId: final.row.id,
          blockType: "text",
          sequence: 4,
          content: "part two",
        });
        await repos.blocks.create({
          turnId: ids.execution,
          responseId: final.row.id,
          blockType: "text",
          sequence: 3,
          content: "final ",
        });
        const terminal = await finalizeExecution(
          { repos, eventWriter },
          {
            threadId: ids.child,
            turnId: ids.execution,
            cause: { kind: "success", finishReason: "end_turn" },
          },
        );
        expect(terminal.report).toMatchObject({
          outcome: "succeeded",
          source: "final_assistant",
          summary: "final part two",
          costMillicredits: 7,
        });
      });
    });
});
