/**
 * PostgreSQL race of an ask's three resolvers: the writer's answer, its deadline and Stop's
 * lineage cancellation, all claiming the same ask row while the cancellation also takes thread
 * locks; and the stopped thread's fence: its queued machine messages go, and an execution admitted
 * before the Stop can't message it, while a later one can.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - a continuation's state is `asks.continuation`, and lineage cancellation claims it in one
 *   transaction (apps/server/server/domains/runtime/.context/spawn.md)
 * - an answered ask with NULL `continuation` (resolved by a server from before migration 0108)
 *   still owes its continuation, and exactly one claim admits it (shared/ask-continuation-owed.ts)
 * - the machine-wake fence is `threads.wake_fence_at` compared with the sender lease's
 *   `acquired_at`, both on the database clock, and the delivery enqueue checks it
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
    const { createDrizzleRunClaim } = await import("../adapters/drizzle-run-claim.js");
    const { createTestDrizzleDelivery } = await import(
      "../loop/__tests__/test-drizzle-delivery.js"
    );
    const { createLineageCancellation } = await import("../spawn/lineage-cancellation.js");
    const { createAskService } = await import("./ask-service.js");
    const { WakeRefusedError } = await import("../loop/run-turn-port.js");

    assertThrowawayDatabaseForRunDbTests(databaseUrl);
    const db = createDb(databaseUrl, { max: 6 });
    const repos = createDrizzleRepositoriesForTest(db);
    const eventWriter = createQuietDrizzleJournalWriter(db);
    const delivery = createTestDrizzleDelivery(db, { repos, eventWriter });
    const runClaim = createDrizzleRunClaim(db);
    const asks = createAskService({ repos, eventWriter, delivery });
    const lineage = createLineageCancellation({
      transaction: repos.transaction,
      threads: repos.threads,
      runClaim,
      delivery,
      asks,
      askRows: repos.asks,
      reports: repos.executionReports,
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
      let prev = ids.callerTurn;
      for (let round = 0; round < 8; round += 1) {
        const executionId = crypto.randomUUID();
        const turn = await repos.turns.create({
          threadId: ids.caller,
          prevTurnId: prev,
          role: "assistant",
          origin: "assistant",
          status: "awaiting_answer",
          executionId,
        });
        prev = turn.id;
        const ask = await repos.asks.create({
          threadId: ids.caller,
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
        // Stop on the chat reaches its ask whatever already resolved it.
        const [answer, expired] = await Promise.all([
          asks.answer({
            userId: ids.user,
            threadId: ids.caller,
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
              eq(schema.threadInboxMessages.threadId, ids.caller),
              isNull(schema.threadInboxMessages.deliveredAt),
              sql`${schema.threadInboxMessages.body}->>'kind' = 'ask_resolved'`,
            ),
          );
        expect(hints).toEqual([]);
      }
    });

    it("admits the continuation of an ask an older server answered, once", async () => {
      const executionId = crypto.randomUUID();
      const turn = await repos.turns.create({
        threadId: ids.caller,
        prevTurnId: ids.callerTurn,
        role: "assistant",
        origin: "assistant",
        status: "awaiting_answer",
        executionId,
      });
      // The older server writes status and resolution only, so `continuation` stays NULL.
      const ask = await repos.asks.create({
        threadId: ids.caller,
        askingTurnId: turn.id,
        executionId,
        toolCallId: "ask-old-server",
        kind: "question",
        payload: { question: "Which?", options: [{ label: "A" }, { label: "B" }] },
        deadlineAt: null,
        status: "answered",
        resolution: { kind: "option", label: "A" },
        submissionId: "old-server-submission",
        resolvedAt: new Date(),
      });
      expect(ask.continuation).toBeNull();
      const admit = (turnId: TurnId) => repos.asks.admitContinuation({ id: ask.id, turnId });
      const [first, second] = await Promise.all([admit(ids.execution), admit(ids.callerTurn)]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect(await repos.asks.findById(ask.id)).toMatchObject({ continuation: "done" });
    });

    it("spares the pending question of an execution Stop did not cancel", async () => {
      const executionId = crypto.randomUUID();
      const turn = await repos.turns.create({
        threadId: ids.caller,
        prevTurnId: ids.callerTurn,
        role: "assistant",
        origin: "assistant",
        status: "streaming",
        executionId,
      });
      const ask = await repos.asks.create({
        threadId: ids.caller,
        askingTurnId: turn.id,
        executionId,
        toolCallId: "ask-spared",
        kind: "question",
        payload: { question: "Which?", options: [{ label: "A" }, { label: "B" }] },
        deadlineAt: null,
        status: "pending",
        resolution: null,
        submissionId: null,
      });
      const stop = (execution: string | null) =>
        lineage.cancel(ids.caller, async () => ({
          result: null,
          reach: { kind: "chat" as const },
          execution,
        }));
      await stop(null);
      expect(await repos.asks.findById(ask.id)).toMatchObject({ status: "pending" });
      await stop(executionId);
      expect(await repos.asks.findById(ask.id)).toMatchObject({ status: "cancelled" });
    });

    it("drops a stopped child's queued messages and fences the run that sent them", async () => {
      const caller = await runClaim.startExecution(ids.caller, crypto.randomUUID(), async () => {});
      if (!caller) throw new Error("caller claim was not taken");
      const sender = { threadId: ids.caller, executionId: caller.executionId };
      const message = (key: string, from: typeof sender) =>
        delivery.enqueue({
          threadId: ids.child,
          intent: "message",
          provenance: { kind: "agent", threadId: ids.caller },
          body: { kind: "text", text: key },
          idempotencyKey: key,
          sender: from,
        });
      const queued = await message("before-stop", sender);

      // The writer stops the child: the caller is outside the lineage.
      await lineage.cancel(ids.child, async () => ({
        result: null,
        reach: { kind: "chat" as const },
        execution: null,
      }));
      expect(await delivery.selectPending(ids.child)).not.toContainEqual(
        expect.objectContaining({ id: queued.id }),
      );
      await expect(message("after-stop", sender)).rejects.toBeInstanceOf(WakeRefusedError);

      // An execution admitted after the Stop messages the child as usual.
      await delivery.withThreadLock(ids.caller, () => runClaim.release(caller));
      const later = await runClaim.startExecution(ids.caller, crypto.randomUUID(), async () => {});
      if (!later) throw new Error("caller claim was not taken again");
      await expect(
        message("later", { threadId: ids.caller, executionId: later.executionId }),
      ).resolves.toMatchObject({ threadId: ids.child });
      await delivery.withThreadLock(ids.caller, () => runClaim.release(later));
    });
  });
