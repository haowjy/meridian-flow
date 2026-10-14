/**
 * Stop and hand-back against PostgreSQL: the design A section 3 rows whose risk is a commit order under
 * the thread lock, adoption refusal, expiry, a repair path or a conversation read. The rows whose risk
 * is the decision alone are `stop-rule.test.ts`. Every case also runs the publication parity check.
 */

import type { HandBackRequest, StopResponse } from "@meridian/contracts/threads";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { journalEventsByThread } from "../../../test-support/journal-events.js";
import { turnGraph } from "../../threads/ports/turn-graph.js";
import { markRunStateChanged, readRunStateAtHead } from "../adapters/drizzle-run-state.js";
import { createCompactionFixture } from "./__tests__/compaction-db-fixture.js";
import { scriptedSummarizer } from "./__tests__/scripted-summarizer.js";
import { scriptedGateway } from "./__tests__/test-gateway.js";
import { NoPendingWakeError } from "./run-turn-port.js";
import { HandBackConflictError } from "./runtime-delivery.js";

const url = process.env.DATABASE_URL;
if (!url || !["1", "true"].includes(process.env.RUN_DB_TESTS ?? ""))
  describe.skip("stop protocol", () => {});
else
  describe("stop protocol", async () => {
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { deleteDrizzleRows } = await import("../../../test-support/drizzle-reset.js");
    const { processDetachedWork } = await import("../detached-work.js");
    assertThrowawayDatabaseForRunDbTests(url);
    const { assertPublicationHooks, openAuditedDatabase } = await import(
      "../../../test-support/run-state-publication.js"
    );
    // Publication pins run in a database this suite owns and drops.
    const audited = await openAuditedDatabase(url, { max: 8 });
    const db = audited.db;
    beforeEach(() => deleteDrizzleRows(db, [schema.users]));
    afterAll(async () => {
      // Background work a run detached (a wake, a renewal) must settle before its database goes.
      await processDetachedWork.drain(10_000);
      await audited.close();
    });
    // Publication pins: no input write without a record, and the last record equals the rows.
    afterEach(() => assertPublicationHooks(db));

    const fixture = createCompactionFixture(db);
    const lowUsage = { inputTokens: 100, outputTokens: 10 };
    type Rig = Awaited<ReturnType<typeof fixture>>;

    /** No auto-compaction and no wake after a release: each test starts every run it wants. */
    async function rigWith(options: Parameters<typeof fixture>[0] = {}) {
      const rig = await fixture({
        gateway: scriptedGateway({ usage: lowUsage }),
        holdWakes: true,
        ...options,
      });
      rig.setThreshold(100000);
      return rig;
    }
    const pausedGateway = (pauseAt: number[] = [1]) =>
      scriptedGateway({ usage: lowUsage, pauseAt });

    /** The press a tab sends from the record it holds: the current one, unless a field is overridden. */
    /** `remote` presses through the delivery port: the holder gets no local abort, as on another server. */
    async function press(
      rig: Rig,
      override: Partial<{
        requestId: string;
        seenThrough: number;
        seenExecutionId: string | null;
        mine: string[];
      }> = {},
      remote = false,
    ): Promise<StopResponse> {
      const state = await readRunStateAtHead(db, rig.threadId as never);
      return (remote ? rig.delivery : rig.orchestrator).stop(rig.threadId as never, {
        requestId: crypto.randomUUID(),
        seenThrough: state.sentThrough,
        seenExecutionId: state.execution?.executionId ?? null,
        mine: [],
        ...override,
      });
    }

    async function inboxRows(rig: Rig) {
      return db
        .select({
          id: schema.threadInboxMessages.id,
          seq: schema.threadInboxMessages.seq,
          deliveredAt: schema.threadInboxMessages.deliveredAt,
          by: schema.threadInboxMessages.deliveredByTurnId,
          handedBackBy: schema.threadInboxMessages.handedBackBy,
        })
        .from(schema.threadInboxMessages)
        .where(
          and(
            eq(schema.threadInboxMessages.threadId, rig.threadId),
            eq(schema.threadInboxMessages.intent, "message"),
          ),
        )
        .orderBy(schema.threadInboxMessages.seq);
    }
    async function rowOf(rig: Rig, id: string) {
      const row = (await inboxRows(rig)).find((candidate) => candidate.id === id);
      if (!row) throw new Error(`No inbox row ${id}`);
      return row;
    }
    async function leaseRow(rig: Rig) {
      const [row] = await db
        .select()
        .from(schema.threadRunLeases)
        .where(eq(schema.threadRunLeases.threadId, rig.threadId));
      return row ?? null;
    }
    async function journalTypes(rig: Rig, type: string) {
      return (await journalEventsByThread(db, rig.threadId)).filter(
        (event) => event.eventType === type,
      );
    }
    const seqOf = async (rig: Rig, id: string) => (await rowOf(rig, id)).seq;

    /** The request text of every model call so far. */
    const requestText = (rig: Rig) => JSON.stringify(rig.gateway.requests);

    /** A reply held at its first model call: the execution is open and its receipt holds the message. */
    async function heldReply(rig: Rig, text: string) {
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, userText: text });
      const done = run.execute();
      await rig.gateway.untilGatewayBoundary(1);
      return { run, done };
    }
    async function startDrain(rig: Rig) {
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      return { run, done: run.execute() };
    }
    async function finish(rig: Rig, done: Promise<unknown>, calls = [1]) {
      for (const call of calls) rig.gateway.release(call);
      await done;
      await processDetachedWork.drain();
    }
    function text(response: StopResponse) {
      return response.handedBack.map(({ blocks }) =>
        blocks.map((b) => ("text" in b ? b.text : "")).join(""),
      );
    }

    function gate() {
      let open!: () => void;
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { promise, open };
    }

    /** A summarizer that holds at its first call until the test lets it finish. */
    function heldSummarizer() {
      const started = gate();
      const released = gate();
      const summarizer = scriptedSummarizer(async () => {
        started.open();
        await released.promise;
        return {
          kind: "complete",
          text: "Earlier context.",
          model: "summary-model",
          modelResponses: [],
        };
      });
      return { summarizer, started: started.promise, release: released.open };
    }

    /**
     * An execution whose holder died: its lease row is expired and binds a pending reply or compaction
     * placeholder with `receipt`, and nothing holds the claim. The record is published as production
     * would have, so only repair and the press move it from here.
     */
    async function deadExecution(rig: Rig, kind: "assistant" | "compaction", receipt: string[]) {
      const executionId = crypto.randomUUID();
      const lease = await rig.runClaim.startExecution(
        rig.threadId as never,
        executionId as never,
        async () => {},
      );
      if (!lease) throw new Error("Expected a run claim");
      const leaf = (await rig.repos.threads.findById(rig.threadId))?.activeLeafTurnId ?? null;
      const turn = await rig.repos.turns.create({
        threadId: rig.threadId as never,
        prevTurnId: leaf,
        role: kind,
        origin: kind === "compaction" ? "system" : "assistant",
        status: kind === "compaction" ? "pending" : "streaming",
        executionId,
        reservedForUserTurnIds: receipt,
      });
      await rig.delivery.withThreadLock(rig.threadId as never, async () => {
        await currentDrizzleDb(db)
          .update(schema.threadRunLeases)
          .set({ turnId: turn.id, boundTurnIds: [turn.id], adoptedMessageIds: receipt })
          .where(eq(schema.threadRunLeases.threadId, rig.threadId));
        markRunStateChanged(rig.threadId as never);
      });
      await rig.runClaim.abandon(lease);
      return { executionId, turn };
    }
    /** The next claim holder's repair of whatever the dead holder left. */
    async function repair(rig: Rig) {
      await rig.runClaim.withExclusiveThread(rig.threadId as never, () =>
        rig.delivery.settleStaleExecution(rig.threadId as never),
      );
      await processDetachedWork.drain();
    }
    /** Whether an execution that reserved a turn has ended: its lease row is gone. */
    async function ended(rig: Rig, executionId: string | null) {
      if (!executionId) return false;
      const carried = (await rig.repos.turns.listByExecution(rig.threadId as never, executionId))
        .length;
      const rows = await db
        .select({ id: schema.threadRunLeases.executionId })
        .from(schema.threadRunLeases)
        .where(eq(schema.threadRunLeases.executionId, executionId));
      return carried > 0 && rows.length === 0;
    }

    it("row 3: a message waiting after a yield and an applied switch is handed back, and no reply starts", async () => {
      const toolUse = {
        content: [
          {
            type: "tool_use" as const,
            toolCallId: "boundary",
            toolName: "unavailable_probe_tool",
            input: {},
          },
        ],
        toolCalls: [],
        finishReason: "tool_use" as const,
        usage: lowUsage,
        model: "gpt-4.1-mini",
        provider: "openai",
      };
      let rig: Rig;
      let m2 = "";
      const gateway = scriptedGateway({
        usage: lowUsage,
        results: [toolUse],
        onStream: async (call) => {
          if (call !== 1) return;
          await rig.delivery.enqueueControl({
            threadId: rig.threadId as never,
            actorId: rig.ids.user,
            id: crypto.randomUUID(),
            control: { kind: "write_mode", mode: "draft" },
          });
          m2 = (await rig.send(rig.threadId, "M2 behind the switch")).userTurnId;
        },
      });
      rig = await rigWith({ gateway });
      await (
        await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "first reply" })
      ).execute();
      await processDetachedWork.drain();
      // E1 ended at the yield; the wake has not run. The switch applies, then the press arrives.
      expect(await rig.delivery.applyDueSwitches(rig.threadId as never)).toBe(true);
      expect((await rowOf(rig, m2)).deliveredAt).toBeNull();

      const response = await press(rig, { seenThrough: await seqOf(rig, m2) });
      expect(response.cancelledExecutionId).toBeNull();
      expect(text(response)).toEqual(["M2 behind the switch"]);
      expect((await rowOf(rig, m2)).handedBackBy).not.toBeNull();
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      expect(
        turns.some((turn) => (turn.metadata as { kind?: string })?.kind === "write_mode_switch"),
      ).toBe(true);
      expect(response.runState.mode).toBe("draft");
      // No reply B: the wake finds nothing.
      await rig.orchestrator.startDrain(rig.threadId as never);
      await processDetachedWork.drain();
      expect(gateway.requests).toHaveLength(1);
    });

    it("row 5: a mixed batch the press set only half covers keeps running and answers both", async () => {
      const gateway = pausedGateway();
      const rig = await rigWith({ gateway });
      const m2 = (await rig.send(rig.threadId, "M2")).userTurnId;
      const seenThrough = await seqOf(rig, m2);
      const m3 = (await rig.send(rig.threadId, "M3")).userTurnId;
      const { run, done } = await startDrain(rig);
      await gateway.untilGatewayBoundary(1);
      expect((await leaseRow(rig))?.adoptedMessageIds).toEqual([m2, m3]);

      const response = await press(rig, { seenThrough, seenExecutionId: null });
      expect(response).toMatchObject({
        cancelledExecutionId: null,
        handedBack: [],
        answered: [m2],
      });
      expect((await leaseRow(rig))?.cancelRequested).toBe(false);
      await finish(rig, done);
      const a = (await rowOf(rig, m2)).by;
      expect(a).not.toBeNull();
      expect((await rowOf(rig, m3)).by).toBe(a);
      expect(run.executionTurnId).toBe(a);
    });

    it("row 6: a separate batch for M3 is refused by the flag, and the next execution answers it", async () => {
      const gateway = pausedGateway();
      const rig = await rigWith({ gateway });
      const m2 = (await rig.send(rig.threadId, "M2")).userTurnId;
      const seenThrough = await seqOf(rig, m2);
      const { done } = await startDrain(rig);
      await gateway.untilGatewayBoundary(1);
      const m3 = (await rig.send(rig.threadId, "M3 arrives later")).userTurnId;

      const response = await press(rig, { seenThrough });
      expect(response.cancelledExecutionId).not.toBeNull();
      expect(response.handedBack).toEqual([]);
      await finish(rig, done);
      expect((await rowOf(rig, m2)).by).not.toBeNull();
      // The flag refused M3's adoption, so it is still pending for the next execution.
      expect((await rowOf(rig, m3)).deliveredAt).toBeNull();
      expect(await leaseRow(rig)).toBeNull();
      const e3 = await startDrain(rig);
      await finish(rig, e3.done, [2]);
      const reply = (await rowOf(rig, m3)).by;
      expect(reply).not.toBeNull();
      expect(reply).not.toBe((await rowOf(rig, m2)).by);
    });

    it("row 7: a press committed before the wake reserves hands M2 back, and the reply is reserved for M3 alone", async () => {
      const gateway = scriptedGateway({ usage: lowUsage });
      const rig = await rigWith({ gateway });
      const m2 = (await rig.send(rig.threadId, "M2 handed back")).userTurnId;
      const seenThrough = await seqOf(rig, m2);
      const m3 = (await rig.send(rig.threadId, "M3 stays")).userTurnId;
      const response = await press(rig, { seenThrough });
      expect(response.handedBack.map(({ userTurnId }) => userTurnId)).toEqual([m2]);

      const { done } = await startDrain(rig);
      await done;
      await processDetachedWork.drain();
      const reply = (await rowOf(rig, m3)).by;
      expect(reply).not.toBeNull();
      const [turn] = await db
        .select({ reservedFor: schema.turns.reservedForUserTurnIds })
        .from(schema.turns)
        .where(eq(schema.turns.id, reply as never));
      expect(turn?.reservedFor).toEqual([m3]);
      expect(requestText(rig)).not.toContain("M2 handed back");
      expect(requestText(rig)).toContain("M3 stays");
    });

    it("row 8: a batch prepared before the press is re-selected at commit and no longer holds M2", async () => {
      const gateway = scriptedGateway({ usage: lowUsage });
      let pressed: Promise<StopResponse> | undefined;
      let rig: Rig;
      let m2 = "";
      let seenThrough = 0;
      let armed = false;
      // The first peek once armed is the wake's unlocked preparation, after it read [M2, M3].
      const notices = {
        async peek() {
          if (armed) pressed ??= press(rig, { seenThrough });
          await pressed;
          return [];
        },
        async consume() {},
      };
      rig = await rigWith({ gateway, notices: notices as never });
      m2 = (await rig.send(rig.threadId, "M2 handed back")).userTurnId;
      seenThrough = await seqOf(rig, m2);
      const m3 = (await rig.send(rig.threadId, "M3 stays")).userTurnId;
      armed = true;

      const { done } = await startDrain(rig);
      await done;
      await processDetachedWork.drain();
      expect((await rowOf(rig, m2)).handedBackBy).not.toBeNull();
      const reply = (await rowOf(rig, m3)).by;
      expect(reply).not.toBeNull();
      expect(requestText(rig)).not.toContain("M2 handed back");
      expect(requestText(rig)).toContain("M3 stays");
    });

    it("row 9: a press that waits on the wake's locked attempt runs after the adoption and finds M3 taken on", async () => {
      const gateway = pausedGateway();
      let rig: Rig;
      let armed = false;
      let injecting = false;
      let peeks = 0;
      const lockedAttempt = gate();
      // Two stale preparations, then the final locked attempt: it holds the thread lock a moment so the
      // press, sent from outside the attempt, queues behind it.
      const notices = {
        async peek() {
          if (!armed || injecting) return [];
          peeks += 1;
          if (peeks <= 2) {
            injecting = true;
            await rig.send(rig.threadId, `extra ${peeks}`);
            injecting = false;
          } else if (peeks === 3) {
            lockedAttempt.open();
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          return [];
        },
        async consume() {},
      };
      rig = await rigWith({ gateway, notices: notices as never });
      const m2 = (await rig.send(rig.threadId, "M2")).userTurnId;
      const seenThrough = await seqOf(rig, m2);
      armed = true;
      const { done } = await startDrain(rig);
      await lockedAttempt.promise;
      const response = await press(rig, { seenThrough });
      await gateway.untilGatewayBoundary(1);
      expect(response).toMatchObject({
        cancelledExecutionId: null,
        handedBack: [],
        answered: [m2],
      });
      const adopted = (await leaseRow(rig))?.adoptedMessageIds ?? [];
      expect(adopted).toHaveLength(3);
      expect((await leaseRow(rig))?.cancelRequested).toBe(false);
      // The alternative: the watermark covers the whole adopted batch, so E2 is cancelled and answers all three.
      const covering = await press(rig, { seenThrough: await seqOf(rig, adopted[2] as string) });
      expect(covering).toMatchObject({ handedBack: [], answered: expect.arrayContaining(adopted) });
      expect(covering.cancelledExecutionId).not.toBeNull();
      expect((await leaseRow(rig))?.cancelRequested).toBe(true);
      gateway.release(1);
      expect(await done).toMatchObject({ status: "cancelled" });
      await processDetachedWork.drain();
      expect((await rowOf(rig, m2)).by).not.toBeNull();
    });

    it("row 11: a later steer not yet adopted stays pending when the press cancels, and the next execution answers it", async () => {
      const gateway = pausedGateway();
      const rig = await rigWith({ gateway });
      const { run, done } = await heldReply(rig, "M1");
      const seenThrough = await seqOf(rig, run.userTurnId);
      const m3 = (await rig.send(rig.threadId, "M3 steer")).userTurnId;

      const response = await press(rig, { seenThrough });
      expect(response.cancelledExecutionId).toBe(run.executionId);
      await finish(rig, done);
      expect((await rowOf(rig, run.userTurnId)).by).toBe(run.executionTurnId);
      expect((await rowOf(rig, m3)).deliveredAt).toBeNull();
      const next = await startDrain(rig);
      await next.done;
      await processDetachedWork.drain();
      const reply = (await rowOf(rig, m3)).by;
      expect(reply).not.toBeNull();
      expect(reply).not.toBe(run.executionTurnId);
    });

    it("row 14: a Stop from another server hands a start-time compaction's message back before it summarizes", async () => {
      const summarizer = scriptedSummarizer();
      const rig = await fixture({
        summarizer,
        gateway: scriptedGateway({ usage: lowUsage }),
        holdWakes: true,
      });
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "M1 asks" });
      expect(await rig.repos.turns.findById(run.executionTurnId)).toMatchObject({
        role: "compaction",
      });
      expect((await leaseRow(rig))?.adoptedMessageIds).toEqual([run.userTurnId]);

      // The press commits after the reservation and before execute(): the run holds M1 in its
      // prepared history and has no local abort. The heartbeat has also expired; Stop still cancels
      // the held lease, and execute() must still see it.
      await db
        .update(schema.threadRunLeases)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(schema.threadRunLeases.threadId, rig.threadId));
      const response = await press(rig, { seenThrough: await seqOf(rig, run.userTurnId) }, true);
      expect(response.cancelledExecutionId).toBe(run.executionId);
      expect(response.handedBack.map(({ userTurnId }) => userTurnId)).toEqual([run.userTurnId]);
      expect((await leaseRow(rig))?.adoptedMessageIds).toEqual([]);
      expect((await rig.runClaim.read(rig.threadId as never)).kind).toBe("asleep");
      expect(await run.execute()).toMatchObject({ status: "cancelled" });
      await processDetachedWork.drain();
      expect(summarizer.calls).toHaveLength(0);
      const row = await rowOf(rig, run.userTurnId);
      expect(row.handedBackBy).not.toBeNull();
      expect(row.by).toBeNull();
      await rig.orchestrator.startDrain(rig.threadId as never);
      await processDetachedWork.drain();
      expect(rig.gateway.requests).toHaveLength(0);
      expect(await ended(rig, run.executionId)).toBe(true);
    });

    it("row 16: a manual compaction's waiting message is handed back and the compact control is untouched", async () => {
      const held = heldSummarizer();
      const rig = await rigWith({ summarizer: held.summarizer });
      const control = await rig.delivery.enqueue({
        id: crypto.randomUUID(),
        threadId: rig.threadId as never,
        intent: "control",
        provenance: { kind: "writer", actorId: rig.ids.user },
        body: { kind: "compact" },
        idempotencyKey: crypto.randomUUID(),
      });
      const { run, done } = await startDrain(rig);
      await held.started;
      const m2 = (await rig.send(rig.threadId, "M2 waits")).userTurnId;

      const response = await press(rig);
      expect(response.cancelledExecutionId).toBe(run.executionId);
      expect(text(response)).toEqual(["M2 waits"]);
      held.release();
      await done;
      await processDetachedWork.drain();
      expect((await rowOf(rig, m2)).handedBackBy).not.toBeNull();
      // The compact was acknowledged when its run started; Stop never touches a control.
      expect(await rig.delivery.selectPending(rig.threadId as never)).toEqual([]);
      expect((await rig.repos.turns.findById(run.executionTurnId))?.status).toBe("cancelled");
      expect(control.deliveredAt).toBeNull();
      expect(rig.gateway.requests).toHaveLength(0);
    });

    it("row 23: an expired heartbeat does not refuse the press, and the live holder cancels", async () => {
      const gateway = pausedGateway();
      const rig = await rigWith({ gateway });
      const { run, done } = await heldReply(rig, "M1");
      await db
        .update(schema.threadRunLeases)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(schema.threadRunLeases.threadId, rig.threadId));

      // From another server: the holder gets no local abort and can only see the durable flag.
      const response = await press(rig, {}, true);
      expect(response.cancelledExecutionId).toBe(run.executionId);
      expect((await leaseRow(rig))?.cancelRequested).toBe(true);
      expect((await rig.runClaim.read(rig.threadId as never)).kind).not.toBe("awake");
      // The holder is alive: it renews after the expiry and reads the flag the press set.
      const held = await leaseRow(rig);
      expect(
        await rig.runClaim.renew({
          threadId: rig.threadId as never,
          executionId: run.executionId as never,
          holderId: held?.holderId as never,
        }),
      ).toBe(true);
      expect(await rig.runClaim.read(rig.threadId as never)).toMatchObject({
        kind: "awake",
        cancelRequested: true,
      });
      gateway.release(1);
      expect(await done).toMatchObject({ status: "cancelled" });
    });

    it("row 24: a dead holder's reply keeps its message and the press hands the waiting one back, then repair settles", async () => {
      const rig = await rigWith();
      const m1 = (await rig.send(rig.threadId, "M1")).userTurnId;
      const dead = await deadExecution(rig, "assistant", [m1]);
      const m2 = (await rig.send(rig.threadId, "M2 waits")).userTurnId;

      const response = await press(rig, { seenExecutionId: dead.executionId });
      expect(response.cancelledExecutionId).toBe(dead.executionId);
      expect(text(response)).toEqual(["M2 waits"]);
      expect(response.answered).toEqual([m1]);
      expect((await leaseRow(rig))?.cancelRequested).toBe(true);
      // The record shows the execution until repair settles it.
      expect(response.runState.execution?.executionId).toBe(dead.executionId);

      await repair(rig);
      expect((await rowOf(rig, m1)).by).toBe(dead.turn.id);
      expect((await rowOf(rig, m2)).handedBackBy).not.toBeNull();
      expect(await leaseRow(rig)).toBeNull();
      expect(await ended(rig, dead.executionId)).toBe(true);
    });

    it("row 31: Stop then a crash in a compaction leaves the message out of the chat for the next claim", async () => {
      const rig = await fixture({
        summarizer: scriptedSummarizer(),
        gateway: scriptedGateway({ usage: lowUsage }),
        holdWakes: true,
      });
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "M1" });
      const m1 = run.userTurnId;
      expect(await rig.repos.turns.findById(run.executionTurnId)).toMatchObject({
        role: "compaction",
      });

      // The press lands on the live holder; then the holder dies before it closes.
      const response = await press(
        rig,
        { seenThrough: await seqOf(rig, m1), seenExecutionId: null },
        true,
      );
      expect(response.cancelledExecutionId).toBe(run.executionId);
      expect(text(response)).toEqual(["M1"]);
      expect((await leaseRow(rig))?.adoptedMessageIds).toEqual([]);
      const held = await leaseRow(rig);
      await rig.runClaim.abandon({
        threadId: rig.threadId as never,
        executionId: run.executionId as never,
        holderId: held?.holderId as never,
      });
      await repair(rig);
      // The dead run's in-process handle must go before the next claim can start.
      await run.execute();
      await processDetachedWork.drain();
      expect((await rowOf(rig, m1)).by).toBeNull();
      await rig.orchestrator.startDrain(rig.threadId as never);
      await processDetachedWork.drain();
      expect(rig.gateway.requests).toHaveLength(0);
      expect(await rig.delivery.selectPending(rig.threadId as never)).toEqual([]);
    });

    it("row 32: a press on an abandoned compaction before repair gives the same outcome as row 31", async () => {
      const rig = await rigWith();
      const m1 = (await rig.send(rig.threadId, "M1")).userTurnId;
      const dead = await deadExecution(rig, "compaction", [m1]);

      const response = await press(rig, { seenExecutionId: dead.executionId });
      expect(text(response)).toEqual(["M1"]);
      await repair(rig);
      expect((await rowOf(rig, m1)).handedBackBy).not.toBeNull();
      expect(await leaseRow(rig)).toBeNull();
      await rig.orchestrator.startDrain(rig.threadId as never);
      await processDetachedWork.drain();
      expect(rig.gateway.requests).toHaveLength(0);
    });

    it("row 33: a crash with no press leaves the message pending and the next execution answers it", async () => {
      const rig = await rigWith();
      const m1 = (await rig.send(rig.threadId, "M1 survives")).userTurnId;
      await deadExecution(rig, "compaction", [m1]);
      await repair(rig);
      expect((await rowOf(rig, m1)).deliveredAt).toBeNull();
      await rig.orchestrator.startDrain(rig.threadId as never);
      await processDetachedWork.drain();
      expect((await rowOf(rig, m1)).by).not.toBeNull();
      expect(requestText(rig)).toContain("M1 survives");
    });

    const handBack = (rig: Rig, requestId: string, scope: HandBackRequest["scope"]) =>
      rig.delivery.handBack(rig.threadId as never, { requestId, scope });
    const ids = (ids_: string[]) => ({ kind: "ids" as const, ids: ids_ });
    const content = (response: { handedBack: StopResponse["handedBack"] }) =>
      response.handedBack.map(({ userTurnId, blocks }) => [userTurnId, blocks] as const);

    it("row 34: the x that loses the claim to the wake's adoption answers its message and hands nothing back", async () => {
      const gateway = pausedGateway();
      let rig: Rig;
      let armed = false;
      let injecting = false;
      let peeks = 0;
      const lockedAttempt = gate();
      // As in row 9: two stale preparations, then the final locked attempt, which holds the thread
      // lock while the x queues behind it.
      const notices = {
        async peek() {
          if (!armed || injecting) return [];
          peeks += 1;
          if (peeks <= 2) {
            injecting = true;
            await rig.send(rig.threadId, `M${peeks + 2}`);
            injecting = false;
          } else if (peeks === 3) {
            lockedAttempt.open();
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          return [];
        },
        async consume() {},
      };
      rig = await rigWith({ gateway, notices: notices as never });
      const m2 = (await rig.send(rig.threadId, "M2")).userTurnId;
      armed = true;
      const { done } = await startDrain(rig);
      await lockedAttempt.promise;

      const response = await handBack(rig, crypto.randomUUID(), ids([m2]));
      await gateway.untilGatewayBoundary(1);
      expect(response).toMatchObject({ handedBack: [], answered: [m2], gone: [] });
      const adopted = (await leaseRow(rig))?.adoptedMessageIds ?? [];
      expect(adopted).toHaveLength(3);
      await finish(rig, done);
      const reply = (await rowOf(rig, m2)).by;
      expect(reply).not.toBeNull();
      for (const id of adopted) expect((await rowOf(rig, id)).by).toBe(reply);
      expect(await journalTypes(rig, "messages.handed_back")).toEqual([]);
    });

    it("row 35: Cancel queue committed during a stale preparation leaves the wake nothing to reserve", async () => {
      let rig: Rig;
      let armed = false;
      let m3 = "";
      const notices = {
        async peek() {
          if (!armed) return [];
          armed = false;
          m3 = (await rig.send(rig.threadId, "M3")).userTurnId;
          await handBack(rig, crypto.randomUUID(), {
            kind: "seen",
            seenThrough: await seqOf(rig, m3),
            mine: [],
          });
          return [];
        },
        async consume() {},
      };
      rig = await rigWith({ notices: notices as never });
      const m2 = (await rig.send(rig.threadId, "M2")).userTurnId;
      armed = true;

      await expect(
        rig.orchestrator.prepare({ threadId: rig.threadId, drain: true }),
      ).rejects.toBeInstanceOf(NoPendingWakeError);
      expect((await rowOf(rig, m2)).handedBackBy).not.toBeNull();
      expect((await rowOf(rig, m3)).handedBackBy).not.toBeNull();
      expect(await leaseRow(rig)).toBeNull();
      expect(rig.gateway.requests).toHaveLength(0);
    });

    it("row 36: a replay answers the stored decision, a later request cannot resurrect, and another body is refused", async () => {
      const rig = await rigWith();
      const m2 = (await rig.send(rig.threadId, "M2 words")).userTurnId;
      const m3 = (await rig.send(rig.threadId, "M3 words")).userTurnId;
      const [r1, r2] = [crypto.randomUUID(), crypto.randomUUID()];
      const first = await handBack(rig, r1, ids([m2]));
      expect(text(first as never)).toEqual(["M2 words"]);
      const second = await handBack(rig, r2, {
        kind: "seen",
        seenThrough: await seqOf(rig, m3),
        mine: [],
      });
      expect(second).toMatchObject({ answered: [], gone: [m2] });
      expect(content(second)).toEqual([[m3, [{ type: "text", text: "M3 words" }]]]);

      const replay2 = await handBack(rig, r2, {
        kind: "seen",
        seenThrough: await seqOf(rig, m3),
        mine: [],
      });
      expect(content(replay2)).toEqual(content(second));
      expect(replay2).toMatchObject({ answered: [], gone: [m2] });
      const replay1 = await handBack(rig, r1, ids([m2]));
      expect(content(replay1)).toEqual(content(first));
      // Another body under a used id is a conflict, however it would have decided.
      await expect(handBack(rig, r1, ids([m3]))).rejects.toBeInstanceOf(HandBackConflictError);
      expect((await rowOf(rig, m2)).handedBackBy).toBe(r1);
      expect((await rowOf(rig, m3)).handedBackBy).toBe(r2);
      expect(await journalTypes(rig, "messages.handed_back")).toHaveLength(2);
    });

    it("row 37: a handed-back message is in no conversation read, and the repository ports return the conversation by default", async () => {
      const rig = await rigWith();
      const main = await rig.repos.threads.findById(rig.threadId);
      if (!main) throw new Error("Expected the chat");
      const m2 = (await rig.send(rig.threadId, "M2 hidden words")).userTurnId;
      const m3 = (await rig.send(rig.threadId, "M3 kept words")).userTurnId;
      const r1 = crypto.randomUUID();
      await handBack(rig, r1, ids([m2]));
      const fork = (
        await rig.repos.threads.createDerivedPrimary({
          aiWriteMode: "direct",
          id: crypto.randomUUID(),
          source: main,
          workId: main.workId,
          userId: main.userId,
          projectId: main.projectId,
          originType: "fork",
          originTurnId: m3 as never,
        })
      ).thread;
      const graph = turnGraph(rig.repos.turns);
      const [turn2, turn3] = [await graph.findById(m2 as never), await graph.findById(m3 as never)];
      // The graph keeps both turns: M3 chains after the hidden M2, at its own position.
      expect(turn3?.prevTurnId).toBe(m2);
      expect(turn3?.position).toBe((turn2?.position ?? 0) + 1);
      expect((await graph.listByThread(rig.threadId as never)).map(({ id }) => id)).toContain(m2);

      // The port reads a later reader reaches without knowing about hand-back: all omit M2. Its blocks
      // stay stored for diagnostics, so they are looked up by the table.
      const turns = rig.repos.turns;
      expect(await turns.findById(m2 as never)).toBeNull();
      expect((await turns.listByThread(rig.threadId as never)).map(({ id }) => id)).not.toContain(
        m2,
      );
      const m2Blocks = await db
        .select({ id: schema.turnBlocks.id })
        .from(schema.turnBlocks)
        .where(eq(schema.turnBlocks.turnId, m2));
      expect(m2Blocks.length).toBeGreaterThan(0);
      expect(await rig.repos.blocks.listByTurn(m2 as never)).toEqual([]);
      expect(await rig.repos.blocks.findById(m2Blocks[0]?.id as string)).toBeNull();
      expect(
        (await rig.repos.blocks.listByThread(rig.threadId as never)).map(({ turnId }) => turnId),
      ).not.toContain(m2);

      // The snapshot.
      const { buildThreadSnapshot } = await import("../../threads/thread-snapshot.js");
      const hub = {
        headSeq: async () => 0n,
        readModelProjectionWatermark: async () => 0n,
      } as never;
      const statusReader = {
        read: async () => ({ kind: "asleep" as const }),
        readRunningTurnId: async () => null,
        readOpenExecutionId: async () => null,
        readMany: async () => new Map(),
        readPending: async () => ({ items: [] }),
        readRunState: async () => readRunStateAtHead(db, rig.threadId as never),
      } as never;
      const snapshot = await buildThreadSnapshot(
        rig.repos,
        hub,
        statusReader,
        rig.threadId as never,
      );
      expect(snapshot.turns.map(({ id }) => id)).not.toContain(m2);
      expect(snapshot.turns.map(({ id }) => id)).toContain(m3);
      expect(JSON.stringify(snapshot.turns)).not.toContain("M2 hidden words");
      expect(snapshot.turns.find(({ id }) => id === m3)?.siblingIds).toEqual([m3]);

      // Deliveries and the latest requester text.
      expect((await rig.repos.turns.listMessageDeliveries(rig.threadId as never)).has(m2)).toBe(
        false,
      );
      expect(
        [
          ...(await rig.repos.turns.listLatestLocalRequesterText([rig.threadId as never])).values(),
        ].join(""),
      ).toContain("M3 kept words");

      // Both transcript page units, their counts and ordinals, on the chat and on the fork.
      const { readTranscriptPage, resolveTranscriptSpans } = await import("../../threads/index.js");
      for (const thread of [main, fork]) {
        for (const unit of ["item", "turn"] as const) {
          const page = await readTranscriptPage(rig.repos, thread, {
            order: "oldest_first",
            unit,
            limit: 100,
          });
          const pageIds = page.entries.map(({ turn }) => turn.id);
          expect(pageIds).not.toContain(m2);
          expect(JSON.stringify(page.entries)).not.toContain("M2 hidden words");
          expect(pageIds).toContain(m3);
        }
        const { spans } = await resolveTranscriptSpans(rig.repos, thread);
        const total = await rig.repos.turns.countConversationTurns(spans, 1_000_000);
        const walked: string[] = [];
        for (let ordinal = 1; ordinal <= total; ordinal += 1)
          walked.push(
            (await rig.repos.turns.findConversationTurnByOrdinal(spans, ordinal))?.id ?? "",
          );
        expect(walked).not.toContain(m2);
        expect(walked).toContain(m3);
        expect(walked).not.toContain("");
      }

      // The derive source and the model: the loader's conversation, then a reply on each chat.
      const { loadThreadConversationContext } = await import("../../threads/index.js");
      for (const thread of [main, fork]) {
        const conversation = await loadThreadConversationContext(rig.repos, thread);
        expect(conversation.turns.map(({ id }) => id)).not.toContain(m2);
        expect(conversation.blocks.map(({ turnId }) => turnId)).not.toContain(m2);
        expect(conversation.turns.map(({ id }) => id)).toContain(m3);
      }
      expect(
        (await loadThreadConversationContext(rig.repos, fork)).inherited.turns.map(({ id }) => id),
      ).not.toContain(m2);
      const m4 = (await rig.send(rig.threadId, "M4 next")).userTurnId;
      expect((await rig.repos.turns.findById(m4 as never))?.position).toBe(
        (turn3?.position ?? 0) + 1,
      );
      rig.bindThread(fork.id);
      await rig.send(fork.id, "F question");
      for (const threadId of [rig.threadId, fork.id]) {
        const run = await rig.orchestrator.prepare({ threadId, drain: true });
        await run.execute();
        await processDetachedWork.drain();
      }
      expect(rig.gateway.requests).toHaveLength(2);
      for (const request of rig.gateway.requests) {
        expect(JSON.stringify(request)).not.toContain("M2 hidden words");
        expect(JSON.stringify(request)).toContain("M3 kept words");
      }

      // The chat list: a handed-back message is neither the preview nor the activity head.
      const m5 = (await rig.send(rig.threadId, "M5 hidden preview")).userTurnId;
      await handBack(rig, crypto.randomUUID(), ids([m5]));
      const [head] = await db
        .select({ leaf: schema.threads.conversationalLeafTurnId })
        .from(schema.threads)
        .where(eq(schema.threads.id, rig.threadId));
      expect(head?.leaf).not.toBe(m5);
      expect(
        [
          ...(await rig.repos.turns.listLatestLocalRequesterText([rig.threadId as never])).values(),
        ].join(""),
      ).not.toContain("M5 hidden preview");

      // A send after a handed-back leaf chains from the graph, and its reply never sees M5.
      const m6 = (await rig.send(rig.threadId, "M6 after the hidden leaf")).userTurnId;
      const last = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      await last.execute();
      await processDetachedWork.drain();
      expect((await rowOf(rig, m6)).by).not.toBeNull();
      expect(JSON.stringify(rig.gateway.requests.at(-1))).not.toContain("M5 hidden preview");
    });

    it("row 38: a replay returns the stored decision after the compaction that held the message dies", async () => {
      const rig = await rigWith();
      const m2 = (await rig.send(rig.threadId, "M2 words")).userTurnId;
      const dead = await deadExecution(rig, "compaction", [m2]);
      const request = crypto.randomUUID();
      const first = await handBack(rig, request, ids([m2]));
      expect(first).toMatchObject({ handedBack: [], answered: [m2], gone: [] });

      await repair(rig);
      expect((await rowOf(rig, m2)).deliveredAt).toBeNull();
      const replay = await handBack(rig, request, ids([m2]));
      expect(replay).toMatchObject({ handedBack: [], answered: [m2], gone: [] });
      expect((await rowOf(rig, m2)).handedBackBy).toBeNull();
      expect(await ended(rig, dead.executionId)).toBe(true);
      await rig.orchestrator.startDrain(rig.threadId as never);
      await processDetachedWork.drain();
      expect((await rowOf(rig, m2)).by).not.toBeNull();
      expect(requestText(rig)).toContain("M2 words");
    });

    it("row 39: a run that starts with no writer message after the leaf was handed back chains from the graph and omits it", async () => {
      const summarizer = scriptedSummarizer();
      const rig = await rigWith({ summarizer });
      const m2 = (await rig.send(rig.threadId, "M2 hidden words")).userTurnId;
      await handBack(rig, crypto.randomUUID(), ids([m2]));
      const leaf = await turnGraph(rig.repos.turns).findById(m2 as never);
      expect((await rig.repos.threads.findById(rig.threadId))?.activeLeafTurnId).toBe(m2);
      await rig.delivery.enqueue({
        id: crypto.randomUUID(),
        threadId: rig.threadId as never,
        intent: "control",
        provenance: { kind: "writer", actorId: rig.ids.user },
        body: { kind: "compact" },
        idempotencyKey: crypto.randomUUID(),
      });

      const { run, done } = await startDrain(rig);
      expect(await done).toMatchObject({ status: "complete" });
      await processDetachedWork.drain();
      const compaction = await rig.repos.turns.findById(run.executionTurnId);
      expect(compaction).toMatchObject({ role: "compaction", prevTurnId: m2 });
      expect(compaction?.position).toBe((leaf?.position ?? 0) + 1);
      expect(JSON.stringify(summarizer.calls)).not.toContain("M2 hidden words");
    });

    it("row 40: a completed compaction's pin on a handed-back message neither breaks the next run nor reaches a summary", async () => {
      const held = heldSummarizer();
      const rig = await fixture({
        summarizer: held.summarizer,
        gateway: scriptedGateway({ usage: lowUsage }),
        holdWakes: true,
      });
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        userText: "M1 pinned words",
      });
      const done = run.execute();
      await held.started;
      // A switch and a message behind it queue while C summarizes, so C yields at its boundary.
      await rig.delivery.enqueueControl({
        threadId: rig.threadId as never,
        actorId: rig.ids.user,
        id: crypto.randomUUID(),
        control: { kind: "write_mode", mode: "draft" },
      });
      const m2 = (await rig.send(rig.threadId, "M2 behind the switch")).userTurnId;
      held.release();
      await done;
      await processDetachedWork.drain();
      const compaction = await rig.repos.turns.findById(run.executionTurnId);
      expect(compaction).toMatchObject({ role: "compaction", status: "complete" });
      expect(
        (compaction?.metadata as { pinnedRequestTurnIds?: string[] }).pinnedRequestTurnIds,
      ).toContain(run.userTurnId);
      expect(await leaseRow(rig)).toBeNull();
      expect((await rowOf(rig, run.userTurnId)).deliveredAt).toBeNull();

      await handBack(rig, crypto.randomUUID(), ids([run.userTurnId]));
      // The next run builds its context over the pin and answers M2 without it.
      rig.setThreshold(100000);
      expect(await rig.delivery.applyDueSwitches(rig.threadId as never)).toBe(true);
      const next = await startDrain(rig);
      expect(await next.done).toMatchObject({ status: "complete" });
      await processDetachedWork.drain();
      expect((await rowOf(rig, m2)).by).not.toBeNull();
      const last = rig.gateway.requests.at(-1);
      expect(JSON.stringify(last)).not.toContain("M1 pinned words");
      expect(JSON.stringify(last)).toContain("M2 behind the switch");
      // A cold summary over the same chat builds without the pin too.
      await rig.delivery.enqueue({
        id: crypto.randomUUID(),
        threadId: rig.threadId as never,
        intent: "control",
        provenance: { kind: "writer", actorId: rig.ids.user },
        body: { kind: "compact" },
        idempotencyKey: crypto.randomUUID(),
      });
      const summary = await startDrain(rig);
      expect(await summary.done).toMatchObject({ status: "complete" });
      await processDetachedWork.drain();
      expect(JSON.stringify(held.summarizer.calls.at(-1))).not.toContain("M1 pinned words");
    });
  });
