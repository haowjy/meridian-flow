import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { HandBackRequest, StopResponse } from "@meridian/contracts/threads";
import { NO_OVERRIDES } from "@meridian/contracts/threads";
import { effortLevels } from "@meridian-flow/mars-schema";
import type { GenerateRequest, ModelInfo, StreamEvent } from "@meridian-flow/runtime/gateway";
import { createGateway } from "@meridian-flow/runtime/gateway";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
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
    const { processDetachedWork } = await import("../../../shared/detached-work.js");
    assertThrowawayDatabaseForRunDbTests(url);
    const { assertPublicationHooks, openAuditedDatabase } = await import(
      "../../../test-support/run-state-publication.js"
    );
    const audited = await openAuditedDatabase(url, { max: 8 });
    const db = audited.db;
    beforeEach(() => deleteDrizzleRows(db, [schema.users]));
    afterAll(async () => {
      await processDetachedWork.drain(8_000);
      await audited.close();
    });
    afterEach(() => assertPublicationHooks(db));

    const fixture = createCompactionFixture(db);
    const lowUsage = { inputTokens: 100, outputTokens: 10 };
    type Rig = Awaited<ReturnType<typeof fixture>>;

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

    const requestText = (rig: Rig) => JSON.stringify(rig.gateway.requests);

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
    async function repair(rig: Rig) {
      await rig.runClaim.withExclusiveThread(rig.threadId as never, () =>
        rig.delivery.settleStaleExecution(rig.threadId as never),
      );
      await processDetachedWork.drain();
    }
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

    it("row 3: a message waiting after a yield and a pending switch is handed back, and no reply starts", async () => {
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
        model: "gpt-5.6-luna",
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
            provenance: { kind: "writer", actorId: rig.ids.user },
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
      expect((await rowOf(rig, m2)).deliveredAt).toBeNull();

      const response = await press(rig, { seenThrough: await seqOf(rig, m2) });
      expect(response.cancelledExecutionId).toBeNull();
      expect(text(response)).toEqual(["M2 behind the switch"]);
      expect((await rowOf(rig, m2)).handedBackBy).not.toBeNull();
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      expect(
        turns.some((turn) => (turn.metadata as { kind?: string })?.kind === "write_mode_switch"),
      ).toBe(false);
      expect(response.runState.mode).not.toBe("draft");
      expect(response.runState.items.map((item) => item.control)).toEqual([
        { kind: "write_mode", mode: "draft" },
      ]);
      await rig.orchestrator.startDrain(rig.threadId as never);
      await processDetachedWork.drain();
      expect(gateway.requests).toHaveLength(1);
    });
    it("row 8: a batch prepared before the press is re-selected at commit and no longer holds M2", async () => {
      const gateway = scriptedGateway({ usage: lowUsage });
      let pressed: Promise<StopResponse> | undefined;
      let rig: Rig;
      let m2 = "";
      let seenThrough = 0;
      let armed = false;
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

      const response = await press(rig, {}, true);
      expect(response.cancelledExecutionId).toBe(run.executionId);
      expect((await leaseRow(rig))?.cancelRequested).toBe(true);
      expect((await rig.runClaim.read(rig.threadId as never)).kind).not.toBe("awake");
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
      await run.execute();
      await processDetachedWork.drain();
      expect((await rowOf(rig, m1)).by).toBeNull();
      await rig.orchestrator.startDrain(rig.threadId as never);
      await processDetachedWork.drain();
      expect(rig.gateway.requests).toHaveLength(0);
      expect(await rig.delivery.selectPending(rig.threadId as never)).toEqual([]);
    });
    const handBack = (rig: Rig, requestId: string, ids: HandBackRequest["ids"]) =>
      rig.delivery.handBack(rig.threadId as never, { requestId, ids });
    const content = (response: { handedBack: StopResponse["handedBack"] }) =>
      response.handedBack.map(({ userTurnId, blocks }) => [userTurnId, blocks] as const);

    it("row 34: the x that loses the claim to the wake's adoption answers its message and hands nothing back", async () => {
      const gateway = pausedGateway();
      let rig: Rig;
      let armed = false;
      let injecting = false;
      let peeks = 0;
      const lockedAttempt = gate();
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

      const response = await handBack(rig, crypto.randomUUID(), [m2]);
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
      let m2 = "";
      let m3 = "";
      const notices = {
        async peek() {
          if (!armed) return [];
          armed = false;
          m3 = (await rig.send(rig.threadId, "M3")).userTurnId;
          await handBack(rig, crypto.randomUUID(), [m2, m3]);
          return [];
        },
        async consume() {},
      };
      rig = await rigWith({ notices: notices as never });
      m2 = (await rig.send(rig.threadId, "M2")).userTurnId;
      armed = true;

      await expect(
        rig.orchestrator.prepare({ threadId: rig.threadId, drain: true }),
      ).rejects.toBeInstanceOf(NoPendingWakeError);
      expect((await rowOf(rig, m2)).handedBackBy).not.toBeNull();
      expect((await rowOf(rig, m3)).handedBackBy).not.toBeNull();
      expect(await leaseRow(rig)).toBeNull();
      expect(rig.gateway.requests).toHaveLength(0);
    });

    const toolUseResult = {
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
      model: "gpt-5.6-luna",
      provider: "openai",
    };
    const boundaryGateway = (holdAt: number) =>
      scriptedGateway({
        usage: lowUsage,
        pauseAt: [1, holdAt],
        results: [toolUseResult, toolUseResult],
      });

    it("row 41: Send now with a frozen queue does not cancel the reply that adopted a later message after an x took M2 back", async () => {
      const gateway = boundaryGateway(2);
      const rig = await rigWith({ gateway });
      const { run, done } = await heldReply(rig, "M1");
      const m2 = (await rig.send(rig.threadId, "M2")).userTurnId;
      const frozen = {
        seenThrough: await seqOf(rig, m2),
        seenExecutionId: run.executionId as string,
        waiting: [m2],
      };
      await handBack(rig, crypto.randomUUID(), [m2]);
      const m3 = (await rig.send(rig.threadId, "M3")).userTurnId;
      gateway.release(1);
      await gateway.untilGatewayBoundary(2);
      expect((await leaseRow(rig))?.adoptedMessageIds).toContain(m3);

      const response = await rig.orchestrator.sendNow(rig.threadId as never, frozen);
      expect(response.cancelledExecutionId).toBeNull();
      expect((await leaseRow(rig))?.cancelRequested).toBe(false);
      gateway.release(2);
      expect(await done).toMatchObject({ status: "complete" });
      await processDetachedWork.drain();
    });

    it("row 42: Send now is refused once the reply adopted a waiting message and its acknowledgement cleared the receipt", async () => {
      const gateway = boundaryGateway(3);
      const rig = await rigWith({ gateway });
      const { run, done } = await heldReply(rig, "M1");
      const m2 = (await rig.send(rig.threadId, "M2")).userTurnId;
      const frozen = {
        seenThrough: await seqOf(rig, m2),
        seenExecutionId: run.executionId as string,
        waiting: [m2],
      };
      gateway.release(1);
      await gateway.untilGatewayBoundary(3);
      expect((await rowOf(rig, m2)).by).not.toBeNull();
      expect((await leaseRow(rig))?.adoptedMessageIds ?? []).not.toContain(m2);

      const response = await rig.orchestrator.sendNow(rig.threadId as never, frozen);
      expect(response.cancelledExecutionId).toBeNull();
      expect((await leaseRow(rig))?.cancelRequested).toBe(false);
      gateway.release(3);
      expect(await done).toMatchObject({ status: "complete" });
      await processDetachedWork.drain();
    });

    it("row 36: a replay answers the stored decision, a later request cannot resurrect, and another body is refused", async () => {
      const rig = await rigWith();
      const m2 = (await rig.send(rig.threadId, "M2 words")).userTurnId;
      const m3 = (await rig.send(rig.threadId, "M3 words")).userTurnId;
      const [r1, r2] = [crypto.randomUUID(), crypto.randomUUID()];
      const first = await handBack(rig, r1, [m2]);
      expect(text(first as never)).toEqual(["M2 words"]);
      const second = await handBack(rig, r2, [m2, m3]);
      expect(second).toMatchObject({ answered: [], gone: [m2] });
      expect(content(second)).toEqual([[m3, [{ type: "text", text: "M3 words" }]]]);

      const replay2 = await handBack(rig, r2, [m2, m3]);
      expect(content(replay2)).toEqual(content(second));
      expect(replay2).toMatchObject({ answered: [], gone: [m2] });
      const replay1 = await handBack(rig, r1, [m2]);
      expect(content(replay1)).toEqual(content(first));
      await expect(handBack(rig, r1, [m3])).rejects.toBeInstanceOf(HandBackConflictError);
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
      await handBack(rig, r1, [m2]);
      const fork = (
        await rig.repos.threads.createDerivedPrimary({
          overrides: NO_OVERRIDES,
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
      expect(turn3?.prevTurnId).toBe(m2);
      expect(turn3?.position).toBe((turn2?.position ?? 0) + 1);
      expect((await graph.listByThread(rig.threadId as never)).map(({ id }) => id)).toContain(m2);

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

      expect((await rig.repos.turns.listMessageDeliveries(rig.threadId as never)).has(m2)).toBe(
        false,
      );
      expect(
        [
          ...(await rig.repos.turns.listLatestLocalRequesterText([rig.threadId as never])).values(),
        ].join(""),
      ).toContain("M3 kept words");

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

      const m5 = (await rig.send(rig.threadId, "M5 hidden preview")).userTurnId;
      await handBack(rig, crypto.randomUUID(), [m5]);
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
      const first = await handBack(rig, request, [m2]);
      expect(first).toMatchObject({ handedBack: [], answered: [m2], gone: [] });

      await repair(rig);
      expect((await rowOf(rig, m2)).deliveredAt).toBeNull();
      const replay = await handBack(rig, request, [m2]);
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
      await handBack(rig, crypto.randomUUID(), [m2]);
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
      await rig.delivery.enqueueControl({
        threadId: rig.threadId as never,
        provenance: { kind: "writer", actorId: rig.ids.user },
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
        (compaction!.metadata as { pinnedRequestTurnIds?: string[] }).pinnedRequestTurnIds,
      ).toContain(run.userTurnId);
      expect(await leaseRow(rig)).toBeNull();
      expect((await rowOf(rig, run.userTurnId)).deliveredAt).toBeNull();

      await handBack(rig, crypto.randomUUID(), [run.userTurnId]);
      rig.setThreshold(100000);
      const next = await startDrain(rig);
      expect(await next.done).toMatchObject({ status: "complete" });
      await processDetachedWork.drain();
      expect((await rowOf(rig, m2)).by).not.toBeNull();
      const last = rig.gateway.requests.at(-1);
      expect(JSON.stringify(last)).not.toContain("M1 pinned words");
      expect(JSON.stringify(last)).toContain("M2 behind the switch");
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

    it("a stop before the provider output leaves a response row with no finish reason and missing usage", async () => {
      const arrived = gate();
      const model: ModelInfo = {
        id: "gpt-5.6-luna",
        provider: "openai",
        tokenizer: "o200k",
        displayName: "Fixture",
        contextWindow: 128000,
        maxOutputTokens: 100,
        promptCache: { kind: "automatic", shortTtlSeconds: 60, longTtlSeconds: 60 },
        reasoning: { efforts: ["low", "medium", "high", "max"] },
        wire: "openai-compatible",
        inputModalities: ["text"],
      };
      const base = scriptedGateway({ usage: lowUsage });
      const silent = createServer(() => {});
      await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
      onTestFinished(() => {
        silent.closeAllConnections();
        silent.close();
      });
      const realGateway = createGateway({
        reasoningLevels: effortLevels(),
        providers: [
          {
            id: "openai",
            adapter: "openai-compatible",
            baseUrl: `http://127.0.0.1:${(silent.address() as AddressInfo).port}/v1`,
            models: [model],
          },
        ],
        defaultModel: model.id,
        attemptStallMs: 0,
        attemptCeilingMs: 0,
      });
      const rig = await rigWith({
        gateway: {
          ...base,
          untilGatewayBoundary: () => arrived.promise,
          async *stream(request: GenerateRequest): AsyncGenerator<StreamEvent> {
            base.requests.push(request);
            arrived.open();
            yield* realGateway.stream(request);
          },
        },
      });
      const { run, done } = await heldReply(rig, "stop me early");
      await press(rig);
      expect(await done).toMatchObject({ status: "cancelled" });
      await processDetachedWork.drain();
      const [row, ...rest] = await rig.repos.modelResponses.listByTurn(run.executionTurnId);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        finishReason: null,
        inputTokens: 0,
        outputTokens: 0,
        priceSource: "unknown",
        pricingSnapshot: { usageMeteringStatus: "missing_usage" },
      });
    });
  });
