/** Control inbox ordering, claims and acknowledgements against real PostgreSQL transactions. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CompactionMetadataCodec } from "../../threads/index.js";
import { createCompactionFixture } from "./__tests__/compaction-db-fixture.js";
import { scriptedSummarizer } from "./__tests__/scripted-summarizer.js";
import { createTestDrizzleDelivery } from "./__tests__/test-drizzle-delivery.js";
import { scriptedGateway } from "./__tests__/test-gateway.js";
import { createOrchestrator } from "./orchestrator.js";

const url = process.env.DATABASE_URL;
if (!url || !["1", "true"].includes(process.env.RUN_DB_TESTS ?? ""))
  describe.skip("control protocol", () => {});
else
  describe("control protocol", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createDrizzleRunClaim } = await import("../adapters/drizzle-run-claim.js");
    assertThrowawayDatabaseForRunDbTests(url);
    const db = createDb(url, { max: 8 });
    beforeEach(() => truncateDrizzleTables(db, [schema.users]));
    afterAll(() => db.close());

    const fixture = createCompactionFixture(db);
    async function compactControl(
      rig: Awaited<ReturnType<typeof fixture>>,
      id: string = crypto.randomUUID(),
    ) {
      return rig.delivery.enqueue({
        id,
        threadId: rig.threadId,
        intent: "control",
        provenance: { kind: "writer", actorId: rig.ids.user },
        body: { kind: "compact" },
        idempotencyKey: id,
      });
    }

    it("C6 provider error on M with K queued behind stays sweep-paced", async () => {
      const gateway = scriptedGateway({ usage: { inputTokens: 100, outputTokens: 10 } });
      const stream = gateway.stream;
      let failing = true;
      gateway.stream = async function* (request) {
        if (!failing) {
          yield* stream(request);
          return;
        }
        gateway.requests.push(request);
        yield {
          type: "error",
          code: "provider_error",
          message: "provider failed",
          retryable: false,
        };
      };
      const rig = await manualFixture({ gateway });
      await rig.send(rig.threadId, "M ahead of K");
      await compactControl(rig);
      await drainControls(rig);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const calls = gateway.requests.length;
      console.log(`C6 provider error gateway calls in 5s: ${calls}`);
      failing = false;
      // Let a pre-fix hot loop finish before this test releases its database.
      if (calls === 1) await drainControls(rig);
      await settled(rig);
      expect(calls).toBe(1);
    });

    it.each([
      "unsettled",
      "execution_error",
    ])("C6 auto C with absorbed K and a failed successor stays sweep-paced: %s", async (path) => {
      const rig = await fixture({
        gateway: scriptedGateway({ usage: { inputTokens: 100, outputTokens: 10 } }),
      });
      await rig.send(rig.threadId, "M ahead of K");
      await compactControl(rig);
      const split = rig.delivery.splitAndContinue.bind(rig.delivery);
      const read = rig.runClaim.read.bind(rig.runClaim);
      let failedSuccessor = false;
      rig.delivery.splitAndContinue = async () => {
        failedSuccessor = true;
        throw new Error("successor unavailable");
      };
      rig.runClaim.read = async (id) => {
        if (path === "execution_error" && failedSuccessor) {
          failedSuccessor = false;
          throw new Error("status read failed after successor failure");
        }
        return read(id);
      };
      const outcome = await drainControls(rig);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const calls = rig.summarizer.calls.length;
      console.log(`C6 failed auto successor (${path}) summary calls in 5s: ${calls}`);
      rig.delivery.splitAndContinue = split;
      rig.runClaim.read = read;
      if (calls === 1) await drainControls(rig);
      await settled(rig);
      expect(calls).toBe(1);
      expect(outcome.status).toBe(path === "execution_error" ? "error" : "failed");
    });

    it("C6 withdrawing an absorbed compact leaves M to be answered", async () => {
      const rig = await fixture({
        gateway: scriptedGateway({ usage: { inputTokens: 100, outputTokens: 10 } }),
      });
      await rig.send(rig.threadId, "M ahead of absorbed K");
      const control = await compactControl(rig);
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      const withdrawal = await rig.delivery.withdrawControl(rig.threadId, control.id);
      await run.execute();
      const turns = await settled(rig);
      expect(withdrawal).toEqual({ outcome: "already_finished" });
      expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
      expect(JSON.stringify(rig.gateway.requests.at(-1))).toContain("M ahead of absorbed K");
    });

    it("C6 idle compact ends on C without reserving B", async () => {
      const rig = await fixture();
      rig.setThreshold(100000);
      const control = await compactControl(rig);
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      expect((await run.execute()).status).toBe("complete");
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      expect(turns.at(-1)).toMatchObject({
        role: "compaction",
        status: "complete",
        metadata: { controlMessageId: control.id, trigger: "manual" },
      });
      expect(rig.gateway.requests).toHaveLength(0);
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
      expect(await rig.runClaim.read(rig.threadId)).toEqual({ kind: "asleep" });
    });

    it("C6 a failed manual summary does not fail the queued reply", async () => {
      const rig = await fixture({
        summarizer: scriptedSummarizer(async () => ({
          kind: "failed",
          error: new Error("summary failed"),
          modelResponses: [],
        })),
      });
      rig.setThreshold(100000);
      await compactControl(rig);
      await rig.send(rig.threadId, "hi2");
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      expect((await run.execute()).status).toBe("complete");
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      expect(turns.slice(-2).map((turn) => [turn.role, turn.status])).toEqual([
        ["compaction", "error"],
        ["assistant", "complete"],
      ]);
      expect(JSON.stringify(rig.gateway.requests.at(-1))).toContain("hi2");
    });

    const lowUsage = { inputTokens: 100, outputTokens: 10 };
    async function manualFixture(options: Parameters<typeof fixture>[0] = {}) {
      const rig = await fixture({ gateway: scriptedGateway({ usage: lowUsage }), ...options });
      rig.setThreshold(100000);
      return rig;
    }
    async function drainControls(rig: Awaited<ReturnType<typeof fixture>>) {
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      return run.execute();
    }
    async function settled(rig: Awaited<ReturnType<typeof fixture>>) {
      await expect
        .poll(async () => (await rig.runClaim.read(rig.threadId)).kind, { timeout: 15000 })
        .toBe("asleep");
      await expect
        .poll(() => rig.delivery.selectPending(rig.threadId), { timeout: 15000 })
        .toEqual([]);
      await expect.poll(rig.activeRuns, { timeout: 15000 }).toBe(0);
      return rig.repos.turns.listByThread(rig.threadId);
    }

    it.each(["behind", "ahead", "bent"])("C6 writer order during A: %s", async (order) => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const gateway = scriptedGateway({
        usage: lowUsage,
        onStream: async (call) => {
          if (call !== 1) return;
          if (order !== "behind") await rig.send(rig.threadId, "hi1");
          await compactControl(rig);
          if (order !== "ahead") await rig.send(rig.threadId, "hi2");
        },
      });
      rig = await manualFixture({ gateway });
      const start = (await rig.repos.turns.listByThread(rig.threadId)).length;
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "hi" });
      await run.execute();
      const tail = (await settled(rig)).slice(start);
      expect(tail.map((turn) => turn.role)).toEqual(
        order === "ahead"
          ? ["user", "assistant", "user", "assistant", "compaction"]
          : order === "behind"
            ? ["user", "assistant", "user", "compaction", "assistant"]
            : ["user", "assistant", "user", "user", "compaction", "assistant"],
      );
      if (order !== "ahead") {
        const request = JSON.stringify(gateway.requests.at(-1));
        expect(request).toContain("Earlier context.");
        expect(request.indexOf("Earlier context.")).toBeLessThan(request.indexOf("hi2"));
        if (order === "bent") expect(request).toContain("hi1");
      }
    });

    it("C6 enqueue same id is a no-op before and after execution", async () => {
      const rig = await manualFixture();
      const input = {
        threadId: rig.threadId,
        actorId: rig.ids.user,
        id: crypto.randomUUID(),
        control: { kind: "compact" as const },
      };
      expect((await rig.delivery.enqueueControl(input)).created).toBe(true);
      await expect(
        rig.delivery.enqueueControl({ ...input, threadId: rig.ids.child }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect((await rig.delivery.enqueueControl(input)).created).toBe(false);
      await drainControls(rig);
      const retry = await rig.delivery.enqueueControl(input);
      expect(retry).toMatchObject({ created: false, response: { id: input.id, pending: null } });
      expect(retry.response.turnId).toBeTruthy();
      expect(
        (await rig.repos.turns.listByThread(rig.threadId)).filter(
          (turn) => turn.role === "compaction",
        ),
      ).toHaveLength(1);
    });

    it("C6 withdrawal before reservation keeps the key retired", async () => {
      const rig = await manualFixture();
      const row = await compactControl(rig);
      expect(await rig.delivery.withdrawControl(rig.threadId, row.id)).toEqual({
        outcome: "withdrawn",
      });
      await expect(
        rig.orchestrator.prepare({ threadId: rig.threadId, drain: true }),
      ).rejects.toThrow("no_pending_wake");
      expect(await compactControl(rig, row.id)).toMatchObject({ deliveredAt: expect.any(String) });
      expect(rig.summarizer.calls).toHaveLength(0);
    });

    it("C6 withdrawal after reservation stops C and releases unanswered hi2", async () => {
      const rig = await manualFixture();
      const row = await compactControl(rig);
      const m = await rig.send(rig.threadId, "hi2");
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      expect(await rig.delivery.withdrawControl(rig.threadId, row.id)).toEqual({
        outcome: "stopping",
      });
      expect((await run.execute()).status).toBe("cancelled");
      const turns = await settled(rig);
      expect(turns.find((turn) => turn.id === run.executionTurnId)?.status).toBe("cancelled");
      expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
      expect(JSON.stringify(rig.gateway.requests.at(-1))).toContain("hi2");
      expect(m.userTurnId).toBeTruthy();
    });

    it.each([
      "reservation",
      "summary",
    ])("C6 autocompaction satisfies compact at %s", async (arrival) => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      let controlId = "";
      const summarizer = scriptedSummarizer(async () => {
        if (arrival === "summary") controlId = (await compactControl(rig)).id;
        return {
          kind: "complete",
          text: "Earlier context.",
          model: "summary-model",
          modelResponses: [],
        };
      });
      rig = await fixture({
        summarizer,
        gateway: scriptedGateway({
          usage: lowUsage,
          onStream: async () => {
            expect(await rig.delivery.selectPending(rig.threadId)).not.toContainEqual(
              expect.objectContaining({ id: controlId }),
            );
          },
        }),
      });
      await rig.send(rig.threadId, "ahead");
      if (arrival === "reservation") controlId = (await compactControl(rig)).id;
      await drainControls(rig);
      const cs = (await settled(rig)).filter((turn) => turn.role === "compaction");
      expect(cs).toHaveLength(1);
      expect(cs[0].metadata).toMatchObject({ trigger: "auto", satisfiesControlId: controlId });
    });

    it("C6 no history writes nothing_to_compact without a summary or response", async () => {
      const rig = await manualFixture({ empty: true });
      await compactControl(rig);
      const result = await drainControls(rig);
      expect(result.status).toBe("error");
      const turn = (await rig.repos.turns.listByThread(rig.threadId)).at(-1);
      expect(turn).toMatchObject({
        role: "compaction",
        status: "error",
        metadata: { reason: "nothing_to_compact" },
      });
      if (!turn) throw new Error("Missing C");
      expect(await rig.repos.modelResponses.listByTurn(turn.id)).toEqual([]);
      expect(rig.summarizer.calls).toHaveLength(0);
    });

    it("C6 control-only sweep starts an idle thread", async () => {
      const rig = await manualFixture();
      await compactControl(rig);
      const starts: string[] = [];
      const { sweepWakes } = await import("./sweep-wakes.js");
      await sweepWakes({
        delivery: rig.delivery,
        authority: rig.runClaim,
        runStarter: {
          async start(id) {
            starts.push(id);
          },
        },
        eventSink: rig.deps.eventSink,
        limit: 100,
      });
      expect(starts).toContain(rig.threadId);
    });

    it("C6 parked waiting_interrupt leaves K queued", async () => {
      const rig = await manualFixture();
      const lease = await rig.runClaim.startExecution(rig.threadId, crypto.randomUUID());
      if (!lease) throw new Error("Missing test lease");
      await rig.runClaim.publish(lease, "waiting");
      const row = await compactControl(rig);
      const { sweepWakes } = await import("./sweep-wakes.js");
      const starts: string[] = [];
      await sweepWakes({
        delivery: rig.delivery,
        authority: rig.runClaim,
        runStarter: {
          async start(id) {
            starts.push(id);
          },
        },
        eventSink: rig.deps.eventSink,
        limit: 100,
      });
      expect(starts).not.toContain(rig.threadId);
      expect(await rig.delivery.selectPending(rig.threadId)).toContainEqual(
        expect.objectContaining({ id: row.id }),
      );
      await rig.runClaim.release(lease);
    });

    it("C6 a dead summary is repaired and the same control redelivers", async () => {
      const rig = await manualFixture();
      const row = await compactControl(rig);
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      // Disconnecting the owning claim simulates death without the run's cleanup.
      await rig.runClaim.release({
        threadId: rig.threadId,
        runId: run.runId,
        holderId: "fixture-owner",
      });
      // The fixture claim's real holder must close its physical session.
      const replacement = createDrizzleRunClaim(db);
      const delivery = createTestDrizzleDelivery(db, {
        repos: rig.repos,
        eventWriter: rig.eventWriter,
        runClaim: replacement,
      });
      const runner = createOrchestrator({ ...rig.deps, runClaim: replacement, delivery });
      const retry = await runner.prepare({ threadId: rig.threadId, drain: true });
      expect((await retry.execute()).status).toBe("complete");
      const cs = (await rig.repos.turns.listByThread(rig.threadId)).filter(
        (turn) => turn.role === "compaction",
      );
      expect(cs.map((turn) => turn.status)).toEqual(["error", "complete"]);
      expect(cs[0]).toMatchObject({
        error: "This manual compaction was interrupted.",
        metadata: { reason: "interrupted", phase: "recovery" },
      });
      expect(CompactionMetadataCodec.safeParse(cs[0].metadata).success).toBe(true);
      expect(cs[1].metadata).toMatchObject({ controlMessageId: row.id });
      const journal = await db
        .select({ payload: schema.eventJournal.payload })
        .from(schema.eventJournal);
      const interruptedEvent = JSON.stringify(journal);
      expect(interruptedEvent).toContain('"code":"compaction_failed"');
      expect(interruptedEvent).toContain('"reason":"interrupted"');
      expect(interruptedEvent).toContain('"phase":"recovery"');
    });

    it.each([
      1, 2,
    ])("C6 %i controls pin both unanswered messages beyond the tail budget", async (count) => {
      const rig = await manualFixture();
      for (let n = 0; n < count; n++) await compactControl(rig);
      const first = await rig.send(rig.threadId, `M1 ${"large unanswered ".repeat(2000)}`);
      const second = await rig.send(rig.threadId, "M2");
      expect((await drainControls(rig)).status).toBe("complete");
      const turns = await settled(rig);
      const cs = turns.filter((turn) => turn.role === "compaction");
      expect(cs).toHaveLength(count);
      if (count === 2)
        expect(cs[1]).toMatchObject({
          status: "error",
          metadata: { reason: "nothing_to_compact" },
        });
      expect(turns.at(-1)?.role).toBe("assistant");
      for (const c of cs)
        if (c.status === "complete")
          expect(c.metadata).toMatchObject({
            pinnedRequestTurnIds: expect.arrayContaining([first.userTurnId, second.userTurnId]),
          });
      const request = JSON.stringify(rig.gateway.requests.at(-1));
      expect(request).toContain(`M1 ${"large unanswered ".repeat(2000)}`);
      expect(request).toContain("M2");
    });

    it("C6 notice before K is adopted, inbox-only agent message after K waits", async () => {
      const rig = await manualFixture();
      await rig.delivery.enqueue({
        threadId: rig.threadId,
        intent: "notice",
        provenance: { kind: "system", source: "test" },
        body: { kind: "text", text: "notice before compact" },
        idempotencyKey: "notice",
      });
      await compactControl(rig);
      const agent = await rig.delivery.enqueue({
        threadId: rig.threadId,
        intent: "message",
        provenance: { kind: "agent", threadId: rig.ids.child },
        body: { kind: "text", text: "agent after compact" },
        idempotencyKey: "agent",
      });
      await drainControls(rig);
      const tail = (await settled(rig)).slice(-4);
      expect(tail.map((turn) => turn.role)).toEqual(["system", "compaction", "user", "assistant"]);
      expect(tail[2].id).toBe(agent.id);
    });

    it("C6 manual compact at a tool boundary continues the task", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const gateway = scriptedGateway({
        usage: lowUsage,
        results: [
          {
            content: [
              { type: "tool_use", toolCallId: "t1", toolName: "unavailable_probe_tool", input: {} },
            ],
            toolCalls: [],
            finishReason: "tool_use",
            usage: lowUsage,
            model: "gpt-4.1-mini",
            provider: "openai",
          },
        ],
        onStream: async (call) => {
          if (call === 1) await compactControl(rig);
        },
      });
      rig = await manualFixture({ gateway });
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "hi" });
      expect((await run.execute()).status).toBe("complete");
      expect((await settled(rig)).slice(-3).map((turn) => turn.role)).toEqual([
        "assistant",
        "compaction",
        "assistant",
      ]);
      expect(gateway.requests).toHaveLength(2);
    });

    it("C6 withdrawal wins an in-flight optimistic reservation prepare", async () => {
      const rig = await manualFixture();
      const control = await compactControl(rig);
      let entered!: () => void;
      let release!: () => void;
      const preparing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      const render = rig.deps.workContext.renderForThread;
      rig.deps.workContext.renderForThread = async (...args) => {
        entered();
        await resume;
        return render(...args);
      };
      const preparation = rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      const rejected = expect(preparation).rejects.toThrow("no_pending_wake");
      await preparing;
      expect(await rig.delivery.withdrawControl(rig.threadId, control.id)).toEqual({
        outcome: "withdrawn",
      });
      release();
      await rejected;
      expect(
        (await rig.repos.turns.listByThread(rig.threadId)).some(
          (turn) => turn.role === "compaction",
        ),
      ).toBe(false);
    });

    it("C6 a manual minimal tail exceeding the usable window calls no summarizer", async () => {
      const rig = await manualFixture();
      rig.deps.gateway.listModels = () => [
        {
          id: "gpt-4.1-mini",
          provider: "openai",
          displayName: "small",
          contextWindow: 1000,
          maxOutputTokens: 100,
          tokenizer: "o200k",
          promptCache: { kind: "none", ttlMs: null },
          capabilities: new Set(),
        },
      ];
      await compactControl(rig);
      await rig.send(rig.threadId, "unanswered ".repeat(1000));
      await drainControls(rig);
      const c = (await rig.repos.turns.listByThread(rig.threadId)).find(
        (turn) => turn.role === "compaction",
      );
      expect(c).toMatchObject({
        status: "error",
        metadata: { reason: "context_too_large", phase: "initial_prepare" },
      });
      expect(rig.summarizer.calls).toHaveLength(0);
    });

    it("C6 Work coalescing and acknowledgement stay on the eligible side of K", async () => {
      const rig = await manualFixture();
      const delivery = createTestDrizzleDelivery(db, {
        repos: rig.repos,
        eventWriter: rig.eventWriter,
        runClaim: rig.runClaim,
        workContext: rig.deps.workContext,
      });
      rig.deps.delivery = delivery;
      const w = (id: string) =>
        delivery.enqueue({
          threadId: rig.threadId,
          intent: "notice",
          provenance: { kind: "system", source: "work_context" },
          body: { kind: "work_context_refresh" },
          idempotencyKey: id,
        });
      const before = await w("before");
      await compactControl({ ...rig, delivery });
      const after = await w("after");
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      const pending = await delivery.selectPending(rig.threadId);
      expect(pending.map((row) => row.id)).not.toContain(before.id);
      expect(pending.map((row) => row.id)).toContain(after.id);
      expect(await rig.repos.turns.findById(before.id)).not.toBeNull();
      expect(await rig.repos.turns.findById(after.id)).toBeNull();
      await run.execute();
    });

    it("C6 remote Stop during a manual summary wakes the owner after release", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const remote = createDrizzleRunClaim(db, { holderId: "remote-controller" });
      const summarizer = scriptedSummarizer(async ({ turnId }) => {
        expect(await remote.cancelExecution(rig.threadId, turnId)).toBe(true);
        return { kind: "failed", error: new Error("stopped elsewhere"), modelResponses: [] };
      });
      rig = await manualFixture({ summarizer });
      await compactControl(rig);
      await rig.send(rig.threadId, "hi2 after remote Stop");
      expect((await drainControls(rig)).status).toBe("cancelled");
      const turns = await settled(rig);
      expect(turns.find((turn) => turn.role === "compaction")?.status).toBe("cancelled");
      expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
      expect(JSON.stringify(rig.gateway.requests.at(-1))).toContain("hi2 after remote Stop");
    });

    it.each([
      "stop",
      "kill",
    ])("C6 %s between consecutive controls always finds a pending current turn", async (action) => {
      const rig = await manualFixture();
      await compactControl(rig);
      const second = await compactControl(rig);
      await rig.send(rig.threadId, "M after both controls");
      const split = rig.delivery.splitAndContinue.bind(rig.delivery);
      let interrupted = false;
      rig.delivery.splitAndContinue = async (input) => {
        const result = await split(input);
        if (!interrupted && result.next.role === "compaction") {
          interrupted = true;
          expect(await rig.runClaim.readRunningTurnId(rig.threadId)).toBe(result.next.id);
          expect(await rig.repos.turns.findById(result.next.id)).toMatchObject({
            status: "pending",
            metadata: { controlMessageId: second.id },
          });
          if (action === "stop") await rig.runClaim.cancelExecution(rig.threadId, result.next.id);
          else {
            const { UnsettledPlaceholderError } = await import("./run-turn-port.js");
            throw new UnsettledPlaceholderError(new Error("process lost after commit"));
          }
        }
        return result;
      };
      await drainControls(rig);
      const turns = await settled(rig);
      expect(interrupted).toBe(true);
      const cs = turns.filter((turn) => turn.role === "compaction");
      expect(cs[0].status).toBe("complete");
      expect(cs[1].status).toBe(action === "stop" ? "cancelled" : "error");
      expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
      expect(JSON.stringify(rig.gateway.requests.at(-1))).toContain("M after both controls");
    });

    it("C6 a child control alone admits no report; its first directed arrival admits on B", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const summarizer = scriptedSummarizer(async () => {
        await rig.delivery.enqueue({
          threadId: rig.threadId,
          intent: "message",
          provenance: { kind: "agent", threadId: rig.ids.caller },
          body: { kind: "text", text: "parent follow-up" },
          idempotencyKey: "parent",
        });
        return {
          kind: "complete",
          text: "Earlier context.",
          model: "summary-model",
          modelResponses: [],
        };
      });
      rig = await manualFixture({ child: true, summarizer });
      const previous = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        userText: "earlier request",
      });
      expect((await previous.execute()).status).toBe("complete");
      await compactControl(rig);
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      expect(
        await rig.repos.executionReports.findByExecution(rig.threadId, run.executionTurnId),
      ).toBeNull();
      expect((await run.execute()).status).toBe("complete");
      const b = (await rig.repos.turns.listByThread(rig.threadId)).at(-1);
      expect(
        await rig.repos.executionReports.findByExecution(rig.threadId, b?.id ?? ""),
      ).toMatchObject({ outcome: "succeeded" });
    });
    it("C6 a reserved first reply answers rows ahead of K before compacting", async () => {
      const rig = await manualFixture();
      await rig.send(rig.threadId, "message ahead");
      await compactControl(rig);
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      expect((await run.execute()).status).toBe("complete");
      const turns = await settled(rig);
      expect(turns.slice(-3).map((turn) => turn.role)).toEqual(["user", "assistant", "compaction"]);
      expect(await rig.repos.modelResponses.listByTurn(run.executionTurnId)).toHaveLength(1);
    });

    it("C6 failed control preparation errors its own divider and retires K", async () => {
      const rig = await manualFixture();
      await compactControl(rig);
      rig.deps.workContext.renderForThread = async () => {
        throw new Error("context unavailable");
      };
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      expect((await run.execute()).status).toBe("error");
      expect((await rig.repos.turns.listByThread(rig.threadId)).at(-1)).toMatchObject({
        role: "compaction",
        status: "error",
      });
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
      expect(rig.summarizer.calls).toHaveLength(0);
    });

    it("C6 idle materialization finalizes an orphan before touching the inbox", async () => {
      const rig = await manualFixture();
      const previous = (await rig.repos.turns.listByThread(rig.threadId)).at(-1);
      const stale = await rig.repos.turns.create({
        threadId: rig.threadId,
        prevTurnId: previous?.id,
        role: "compaction",
        origin: "system",
        status: "pending",
        metadata: { trigger: "manual" },
      });
      const control = await compactControl(rig);
      await rig.delivery.materializeIdle(rig.threadId);
      expect(await rig.repos.turns.findById(stale.id)).toMatchObject({
        status: "error",
        metadata: { reason: "interrupted" },
      });
      expect(await rig.delivery.selectPending(rig.threadId)).toContainEqual(
        expect.objectContaining({ id: control.id }),
      );
    });
    it("C6 an optional manual successor exception lands C error and continues B", async () => {
      const rig = await manualFixture();
      await compactControl(rig);
      await rig.send(rig.threadId, "reply survives failure landing");
      const split = rig.delivery.splitAndContinue.bind(rig.delivery);
      let failed = false;
      rig.delivery.splitAndContinue = async (input) => {
        if (!failed && input.current.kind === "placeholder") {
          failed = true;
          throw new Error("successor unavailable once");
        }
        return split(input);
      };
      expect((await drainControls(rig)).status).toBe("complete");
      const turns = await settled(rig);
      expect(turns.slice(-2).map((turn) => [turn.role, turn.status])).toEqual([
        ["compaction", "error"],
        ["assistant", "complete"],
      ]);
      expect(JSON.stringify(rig.gateway.requests.at(-1))).toContain(
        "reply survives failure landing",
      );
    });
    it("C6 Stop on an auto C that absorbed K stops its reply, not only K", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const summarizer = scriptedSummarizer(async ({ turnId }, call) => {
        if (call === 1) await rig.runClaim.cancelExecution(rig.threadId, turnId);
        return {
          kind: "complete",
          text: "Earlier context.",
          model: "summary-model",
          modelResponses: [],
        };
      });
      rig = await fixture({ summarizer, gateway: scriptedGateway({ usage: lowUsage }) });
      await rig.send(rig.threadId, "M ahead of K");
      await compactControl(rig);
      expect((await drainControls(rig)).status).toBe("cancelled");
      const turns = await settled(rig);
      expect(turns.filter((turn) => turn.role === "compaction")).toHaveLength(1);
      expect(rig.gateway.requests).toHaveLength(0);
    });
  });
