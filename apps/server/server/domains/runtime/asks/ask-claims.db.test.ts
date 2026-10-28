/**
 * PostgreSQL race of an ask's three resolvers: the writer's answer, its deadline and a lineage
 * cancellation, all claiming the same ask row while the cancellation also takes thread locks;
 * and the edges a cancellation fences: a forwarded copy goes with its source, and the stopped
 * thread refuses a wake from an execution admitted before the Stop.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - a continuation's state is `asks.continuation`, and lineage cancellation claims it in one
 *   transaction, ask rows before thread locks (apps/server/server/domains/runtime/.context/spawn.md)
 * - the machine-wake fence is `threads.wake_fence_at` compared with the sender lease's
 *   `acquired_at`
 */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { executionScenario } from "../../../test-support/execution-scenario.js";
import { createQuietDrizzleJournalWriter } from "../../../test-support/journal-writer.js";

const runDb = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;
const ids = {
  user: "00000000-0000-4000-8000-000000000ac1",
  project: "00000000-0000-4000-8000-000000000ac2",
  caller: "00000000-0000-4000-8000-000000000ac3" as ThreadId,
  child: "00000000-0000-4000-8000-000000000ac4" as ThreadId,
  callerTurn: "00000000-0000-4000-8000-000000000ac5" as TurnId,
  childUserTurn: "00000000-0000-4000-8000-000000000ac6" as TurnId,
  execution: "00000000-0000-4000-8000-000000000ac7" as TurnId,
};

if (!runDb || !databaseUrl) describe.skip("ask claims (postgres)", () => {});
else
  describe("ask claims (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { and, eq, isNull, sql } = await import("drizzle-orm");
    const { createDb } = await import("@meridian/database");
    const { assertThrowawayDatabaseForRunDbTests } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { deleteDrizzleRows } = await import("../../../test-support/drizzle-reset.js");
    const { runAfterDrizzleCommit } = await import("../../../shared/drizzle-transaction.js");
    const { createDrizzleRepositoriesForTest } = await import(
      "../../threads/adapters/drizzle/repositories.js"
    );
    const { createInMemoryEventSink } = await import("../../observability/index.js");
    const { createDrizzleRunClaim } = await import("../adapters/drizzle-run-claim.js");
    const { createTestDrizzleDelivery } = await import(
      "../loop/__tests__/test-drizzle-delivery.js"
    );
    const { createReportPublisher } = await import("../spawn/report-publisher.js");
    const { createLineageCancellation } = await import("../spawn/lineage-cancellation.js");
    const { createAskService } = await import("./ask-service.js");

    assertThrowawayDatabaseForRunDbTests(databaseUrl);
    const db = createDb(databaseUrl, { max: 6 });
    const repos = createDrizzleRepositoriesForTest(db);
    const eventWriter = createQuietDrizzleJournalWriter(db);
    const delivery = createTestDrizzleDelivery(db, { repos, eventWriter });
    const runClaim = createDrizzleRunClaim(db);
    const asks = createAskService({ repos, eventWriter, delivery, wakes: runClaim });
    const lineage = createLineageCancellation({
      transaction: repos.transaction,
      threads: repos.threads,
      runClaim,
      delivery,
      asks,
      askRows: repos.asks,
      reports: repos.executionReports,
      publisher: createReportPublisher({
        repos,
        eventWriter,
        delivery,
        eventSink: createInMemoryEventSink(),
      }),
      refreshActivity() {},
      afterCommit: runAfterDrizzleCommit,
    });

    beforeEach(async () => {
      await deleteDrizzleRows(db, [schema.users]);
      await executionScenario(db, ids);
    });
    afterAll(async () => {
      await db.$client.end();
    });

    it("leaves nothing owed and no wake hint, whichever resolver claims first", async () => {
      let prev = ids.execution;
      for (let round = 0; round < 8; round += 1) {
        const executionId = crypto.randomUUID();
        const turn = await repos.turns.create({
          threadId: ids.child,
          prevTurnId: prev,
          role: "assistant",
          origin: "assistant",
          status: "awaiting_answer",
          executionId,
        });
        prev = turn.id;
        const ask = await repos.asks.create({
          threadId: ids.child,
          askingTurnId: turn.id,
          executionId,
          toolCallId: `ask-${round}`,
          kind: "question",
          payload: { question: "Which?", options: [{ label: "A" }, { label: "B" }] },
          deadlineAt: new Date(0),
          status: "open",
          resolution: null,
          submissionId: null,
        });
        // Stop on the caller reaches the child's ask whatever already resolved it.
        const [answer, expired] = await Promise.all([
          asks.answer({
            userId: ids.user,
            threadId: ids.child,
            askId: ask.id,
            submissionId: `submission-${round}`,
            answer: { kind: "option", label: "A" },
          }),
          asks.expireDue(new Date()),
          lineage.cancel(ids.caller, async () => ({
            result: null,
            reach: { kind: "chat" as const },
            execution: null,
          })),
        ]);
        expect(Number(answer.ok) + expired).toBeLessThanOrEqual(1);
        const settled = await repos.asks.findById(ask.id);
        expect(settled).toMatchObject({ continuation: "cancelled" });
        expect(settled?.status).toMatch(/^(answered|expired|cancelled)$/);
        const hints = await db
          .select({ id: schema.threadInboxMessages.id })
          .from(schema.threadInboxMessages)
          .where(
            and(
              eq(schema.threadInboxMessages.threadId, ids.child),
              isNull(schema.threadInboxMessages.deliveredAt),
              sql`${schema.threadInboxMessages.body}->>'kind' = 'ask_resolved'`,
            ),
          );
        expect(hints).toEqual([]);
      }
    });

    it("cancels a forwarded copy with its source and fences the stopped child", async () => {
      const caller = await runClaim.startExecution(ids.caller, crypto.randomUUID(), async () => {});
      if (!caller) throw new Error("caller claim was not taken");
      const childTurn = await repos.turns.create({
        threadId: ids.child,
        prevTurnId: ids.execution,
        role: "assistant",
        origin: "assistant",
        status: "awaiting_answer",
        executionId: crypto.randomUUID(),
      });
      const question = {
        kind: "question" as const,
        payload: { question: "Which?", options: [{ label: "A" }] },
        deadlineAt: null,
        status: "open" as const,
        resolution: null,
        submissionId: null,
      };
      const source = await repos.asks.create({
        ...question,
        threadId: ids.child,
        askingTurnId: childTurn.id,
        executionId: childTurn.executionId as string,
        toolCallId: "child-ask",
      });
      const callerTurn = await repos.turns.create({
        threadId: ids.caller,
        prevTurnId: ids.callerTurn,
        role: "assistant",
        origin: "assistant",
        status: "awaiting_answer",
        executionId: caller.executionId,
      });
      const copy = await repos.asks.create({
        ...question,
        threadId: ids.caller,
        askingTurnId: callerTurn.id,
        executionId: caller.executionId,
        toolCallId: "forward",
        forwardedFromAskId: source.id,
      });

      // The writer stops the child: the caller is outside the lineage, its copy is not.
      await lineage.cancel(ids.child, async () => ({
        result: null,
        reach: { kind: "chat" as const },
        execution: null,
      }));
      expect(await repos.asks.findById(copy.id)).toMatchObject({ status: "cancelled" });
      const sender = { threadId: ids.caller, executionId: caller.executionId };
      expect(await runClaim.wakeRefusal({ sender, receiver: ids.child })).toBe("receiver_stopped");
      expect(await runClaim.wakeRefusal({ sender, receiver: null })).toBeNull();

      // An execution admitted after the Stop wakes the child as usual.
      await delivery.withThreadLock(ids.caller, () => runClaim.release(caller));
      const later = await runClaim.startExecution(ids.caller, crypto.randomUUID(), async () => {});
      if (!later) throw new Error("caller claim was not taken again");
      expect(
        await runClaim.wakeRefusal({
          sender: { threadId: ids.caller, executionId: later.executionId },
          receiver: ids.child,
        }),
      ).toBeNull();
      await delivery.withThreadLock(ids.caller, () => runClaim.release(later));
    });
  });
