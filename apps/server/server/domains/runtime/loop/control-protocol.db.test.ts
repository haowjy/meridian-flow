/** Control queue ordering, start consumption, and withdrawal against PostgreSQL. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCompactionFixture } from "./__tests__/compaction-db-fixture.js";
import { scriptedSummarizer } from "./__tests__/scripted-summarizer.js";
import { scriptedGateway } from "./__tests__/test-gateway.js";

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
    const { deleteDrizzleRows } = await import("../../../test-support/drizzle-reset.js");
    assertThrowawayDatabaseForRunDbTests(url);
    const db = createDb(url, { max: 8 });
    beforeEach(() => deleteDrizzleRows(db, [schema.users]));
    afterAll(() => db.close());

    const fixture = createCompactionFixture(db);
    const lowUsage = { inputTokens: 100, outputTokens: 10 };

    async function manualFixture(options: Parameters<typeof fixture>[0] = {}) {
      const rig = await fixture({ gateway: scriptedGateway({ usage: lowUsage }), ...options });
      rig.setThreshold(100000);
      return rig;
    }

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

    function assertOneRunStartDuringCleanup(rig: Awaited<ReturnType<typeof fixture>>) {
      const start = rig.runClaim.startExecution.bind(rig.runClaim);
      const starts = vi
        .spyOn(rig.runClaim, "startExecution")
        .mockResolvedValue(null)
        .mockImplementationOnce(start);
      return () => {
        const attempts = starts.mock.calls.length;
        starts.mockRestore();
        expect(attempts).toBe(1);
      };
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

    async function drainControls(rig: Awaited<ReturnType<typeof fixture>>) {
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      return run.execute();
    }

    it("keeps a failed reply sweep-paced while a command waits behind it", async () => {
      const gateway = scriptedGateway({ usage: lowUsage });
      gateway.stream = async function* (request) {
        gateway.requests.push(request);
        yield {
          type: "error",
          code: "provider_error",
          message: "provider unavailable",
          retryable: false,
        };
      };
      const rig = await manualFixture({ gateway });
      await rig.delivery.enqueue({
        threadId: rig.threadId,
        intent: "message",
        provenance: { kind: "writer", actorId: rig.ids.user },
        body: { kind: "text", text: "M ahead of K" },
        idempotencyKey: "failed-message",
      });
      await compactControl(rig);

      const assertOneStart = assertOneRunStartDuringCleanup(rig);
      const failed = await drainControls(rig);
      assertOneStart();
      expect(failed.status).toBe("error");
      expect(gateway.requests).toHaveLength(1);
      expect(await rig.delivery.selectPending(rig.threadId)).toHaveLength(2);
      expect((await rig.delivery.selectPending(rig.threadId))[0]?.intent).toBe("message");

      // The next explicit wake retries the pending reply once. The command remains behind it.
      await drainControls(rig);
      expect(gateway.requests).toHaveLength(2);
    });

    it("wakes a new message after a failed reply without waiting for the sweep", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      let arrivingId = "";
      const gateway = scriptedGateway({
        usage: lowUsage,
        errorAtCall: 1,
        onStream: async (call) => {
          if (call !== 1) return;
          const arriving = await rig.delivery.enqueue({
            threadId: rig.threadId,
            intent: "message",
            provenance: { kind: "writer", actorId: rig.ids.user },
            body: { kind: "text", text: "arrived during failure" },
            idempotencyKey: "arrived-during-failure",
          });
          arrivingId = arriving.id;
        },
      });
      rig = await manualFixture({ gateway });
      const initial = await rig.delivery.enqueue({
        threadId: rig.threadId,
        intent: "message",
        provenance: { kind: "writer", actorId: rig.ids.user },
        body: { kind: "text", text: "first failed request" },
        idempotencyKey: "first-failed-request",
      });

      await drainControls(rig);
      const turns = await settled(rig);

      expect(turns.filter((turn) => turn.id === initial.id)).toHaveLength(1);
      expect(turns).toContainEqual(expect.objectContaining({ id: arrivingId }));
      expect(gateway.requests.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(gateway.requests[1])).toContain("first failed request");
      expect(JSON.stringify(gateway.requests[1])).toContain("arrived during failure");
    });

    it("answers messages before a command queued earlier during the reply", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const gateway = scriptedGateway({
        usage: lowUsage,
        onStream: async (call) => {
          if (call !== 1) return;
          await compactControl(rig);
          await rig.send(rig.threadId, "message after queued compact");
        },
      });
      rig = await manualFixture({ gateway });
      const start = (await rig.repos.turns.listByThread(rig.threadId)).length;
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        userText: "first reply",
      });
      await run.execute();
      const tail = (await settled(rig)).slice(start);

      expect(tail.map((turn) => turn.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "compaction",
      ]);
      expect(JSON.stringify(gateway.requests.at(-1))).toContain("message after queued compact");
      expect(tail.at(-1)?.metadata).toMatchObject({ trigger: "manual" });
    });

    it("Stop runs the queued command first with waiting messages pinned verbatim", async () => {
      const gateway = scriptedGateway({ usage: lowUsage, pauseAt: [1] });
      const rig = await manualFixture({ gateway });
      const active = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        userText: "reply to stop",
      });
      const execution = active.execute();
      await gateway.untilGatewayBoundary(1);

      const control = await compactControl(rig);
      const waitingText = "Keep this exact message after Esc.";
      const waiting = await rig.send(rig.threadId, waitingText);
      expect(await rig.orchestrator.cancel(rig.threadId, active.executionTurnId)).toBe("cancelled");

      gateway.release(1);
      await execution;
      const turns = await settled(rig);
      const command = turns.find(
        (turn) =>
          turn.role === "compaction" &&
          (turn.metadata as { controlMessageId?: string } | null)?.controlMessageId === control.id,
      );

      expect(command).toMatchObject({
        status: "complete",
        metadata: {
          trigger: "manual",
          pinnedRequestTurnIds: [waiting.userTurnId],
        },
      });
      expect(JSON.stringify(gateway.requests.at(-1))).toContain(waitingText);
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
    });

    it("retires a Stop-stamped compact after a failed start commit and answers its messages", async () => {
      const gateway = scriptedGateway({ usage: lowUsage, pauseAt: [1] });
      const rig = await manualFixture({ gateway });
      const active = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        userText: "reply to stop",
      });
      const execution = active.execute();
      await gateway.untilGatewayBoundary(1);

      const control = await compactControl(rig);
      const waitingText = "Answer me after the failed compact.";
      const waiting = await rig.send(rig.threadId, waitingText);
      expect(await rig.orchestrator.cancel(rig.threadId, active.executionTurnId)).toBe("cancelled");
      const transition = rig.repos.runTurnStartTransition.bind(rig.repos);
      let failed = false;
      rig.repos.runTurnStartTransition = async (threadId, expectedLeafTurnId, operation) => {
        if (!failed) {
          failed = true;
          throw new Error("compact start commit failed");
        }
        return transition(threadId, expectedLeafTurnId, operation);
      };

      gateway.release(1);
      await execution;
      const turns = await settled(rig);
      const compact = turns.find(
        (turn) =>
          turn.role === "compaction" &&
          (turn.metadata as { controlMessageId?: string } | null)?.controlMessageId === control.id,
      );

      expect(failed).toBe(true);
      expect(compact).toMatchObject({
        status: "error",
        metadata: { reason: "compaction_failed", phase: "delivery" },
      });
      expect(turns.some((turn) => turn.id === waiting.userTurnId && turn.role === "user")).toBe(
        true,
      );
      expect(JSON.stringify(gateway.requests.at(-1))).toContain(waitingText);
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
    });

    it("runs queued controls one per run and in their queue order", async () => {
      const rig = await manualFixture();
      const first = await compactControl(rig);
      const second = await compactControl(rig);
      const startExecution = vi.spyOn(rig.runClaim, "startExecution");
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      await run.execute();
      const turns = await settled(rig);
      const controls = turns.filter((turn) => turn.role === "compaction");

      expect(startExecution).toHaveBeenCalledTimes(2);
      expect(
        controls.map((turn) => (turn.metadata as { controlMessageId?: string }).controlMessageId),
      ).toEqual([first.id, second.id]);
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
    });

    it("retires a compact whose start transition fails without retrying the command", async () => {
      const rig = await manualFixture();
      const control = await compactControl(rig);
      const transition = rig.repos.runTurnStartTransition.bind(rig.repos);
      let failed = false;
      rig.repos.runTurnStartTransition = async (threadId, expectedLeafTurnId, operation) => {
        if (!failed) {
          failed = true;
          throw new Error("transient start commit failure");
        }
        return transition(threadId, expectedLeafTurnId, operation);
      };
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      await run.execute();
      const turns = await settled(rig);
      const compaction = turns.find(
        (turn) =>
          turn.role === "compaction" &&
          (turn.metadata as { controlMessageId?: string } | null)?.controlMessageId === control.id,
      );

      expect(failed).toBe(true);
      expect(compaction).toMatchObject({
        role: "compaction",
        status: "error",
        metadata: { reason: "compaction_failed", phase: "delivery" },
      });
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
    });

    it("withdrawal is replay-safe before start and refused after start", async () => {
      const rig = await manualFixture();
      const withdrawn = await compactControl(rig);
      expect(await rig.delivery.withdrawControl(rig.threadId, withdrawn.id)).toEqual({
        outcome: "withdrawn",
      });
      expect(await rig.delivery.withdrawControl(rig.threadId, withdrawn.id)).toEqual({
        outcome: "withdrawn",
      });

      const started = await compactControl(rig);
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      expect(await rig.delivery.withdrawControl(rig.threadId, started.id)).toEqual({
        outcome: "already_started",
      });
      await run.execute();
      await settled(rig);
      expect(await rig.delivery.withdrawControl(rig.threadId, started.id)).toEqual({
        outcome: "already_started",
      });
    });

    it("keeps a queued compact after an automatic compaction", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const controlId = crypto.randomUUID();
      const summarizer = scriptedSummarizer(async () => {
        if (rig.summarizer.calls.length === 1) await compactControl(rig, controlId);
        return {
          kind: "complete",
          text: "Earlier context.",
          model: "summary-model",
          modelResponses: [],
        };
      });
      rig = await fixture({
        summarizer,
        gateway: scriptedGateway({ usage: lowUsage }),
      });

      await (
        await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "new history" })
      ).execute();
      const turns = await settled(rig);
      const compactions = turns.filter((turn) => turn.role === "compaction");

      expect(compactions).toHaveLength(2);
      expect(compactions[0]).toMatchObject({ metadata: { trigger: "auto" } });
      expect(compactions[1]).toMatchObject({
        metadata: { trigger: "manual", controlMessageId: controlId },
      });
      expect(summarizer.calls).toHaveLength(2);
    });
  });
