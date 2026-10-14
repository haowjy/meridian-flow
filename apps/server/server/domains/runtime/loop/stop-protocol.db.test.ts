/**
 * Stop and hand-back against PostgreSQL: the design A section 3 rows whose risk is a commit order under
 * the thread lock, adoption refusal, expiry, a repair path or a conversation read. The rows whose risk
 * is the decision alone are `stop-rule.test.ts`. Every case also runs the publication parity check.
 */

import type { StopResponse } from "@meridian/contracts/threads";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { journalEventsByThread } from "../../../test-support/journal-events.js";
import { createDrizzleRunClaim } from "../adapters/drizzle-run-claim.js";
import { readRunStateAtHead } from "../adapters/drizzle-run-state.js";
import { createCompactionFixture } from "./__tests__/compaction-db-fixture.js";
import { scriptedSummarizer } from "./__tests__/scripted-summarizer.js";
import { scriptedGateway } from "./__tests__/test-gateway.js";
import { HandBackConflictError } from "./runtime-delivery.js";

const url = process.env.DATABASE_URL;
if (!url || !["1", "true"].includes(process.env.RUN_DB_TESTS ?? ""))
  describe.skip("stop protocol", () => {});
else
  describe("stop protocol", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { deleteDrizzleRows } = await import("../../../test-support/drizzle-reset.js");
    const { processDetachedWork } = await import("../detached-work.js");
    assertThrowawayDatabaseForRunDbTests(url);
    const db = createDb(url, { max: 8 });
    beforeEach(() => deleteDrizzleRows(db, [schema.users]));
    afterAll(async () => {
      await removePublicationAudit(db);
      await db.close();
    });
    const { assertPublicationHooks, installPublicationAudit, removePublicationAudit } =
      await import("../../../test-support/run-state-publication.js");
    beforeAll(() => installPublicationAudit(db));
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
    async function press(
      rig: Rig,
      override: Partial<{
        requestId: string;
        seenThrough: number;
        seenExecutionId: string | null;
        mine: string[];
      }> = {},
    ): Promise<StopResponse> {
      const state = await readRunStateAtHead(db, rig.threadId as never);
      return rig.orchestrator.stop(rig.threadId as never, {
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
  });
