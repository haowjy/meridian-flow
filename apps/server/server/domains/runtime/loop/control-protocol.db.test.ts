/** Control queue ordering, start consumption, and withdrawal against PostgreSQL. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDrizzleRunClaim } from "../adapters/drizzle-run-claim.js";
import type { Gateway } from "../gateway/ports/gateway.js";
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
    const { deleteDrizzleRows } = await import("../../../test-support/drizzle-reset.js");
    const { processDetachedWork } = await import("../detached-work.js");
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

    it.each([1, 2])("fails once and acknowledges %i adopted message(s)", async (messageCount) => {
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
      for (let index = 0; index < messageCount; index++) {
        await rig.delivery.enqueue({
          threadId: rig.threadId,
          intent: "message",
          provenance: { kind: "writer", actorId: rig.ids.user },
          body: { kind: "text", text: `failed message ${index + 1}` },
          idempotencyKey: `failed-message-${index + 1}`,
        });
      }

      const start = rig.runClaim.startExecution.bind(rig.runClaim);
      const starts = vi.spyOn(rig.runClaim, "startExecution").mockImplementation(start);
      const failed = await drainControls(rig);
      await processDetachedWork.drain();

      expect(failed.status).toBe("error");
      expect(gateway.requests).toHaveLength(1);
      expect(starts).toHaveBeenCalledTimes(1);
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
      expect(await rig.repos.turns.listByThread(rig.threadId)).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: "assistant", status: "error" })]),
      );
      starts.mockRestore();
    });

    it("runs a queued compact immediately after a failed reply", async () => {
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
        idempotencyKey: "failed-message-before-compact",
      });
      const compact = await compactControl(rig);

      await drainControls(rig);
      await processDetachedWork.drain();
      const turns = await settled(rig);

      expect(gateway.requests).toHaveLength(1);
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
      expect(turns).toContainEqual(
        expect.objectContaining({
          role: "compaction",
          status: "complete",
          metadata: expect.objectContaining({ controlMessageId: compact.id }),
        }),
      );
    });

    it("Retry replays the original request, appends after failure, and is idempotent", async () => {
      const gateway = scriptedGateway({ usage: lowUsage });
      const requests = gateway.requests;
      gateway.stream = async function* (request) {
        requests.push(request);
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
        body: { kind: "text", text: "Answer exactly this again." },
        idempotencyKey: "retry-source-message",
      });

      const first = await drainControls(rig);
      await processDetachedWork.drain();
      const failed = await rig.repos.turns.getLatestByThread(rig.threadId);
      expect(first.status).toBe("error");
      expect(failed).toMatchObject({ role: "assistant", status: "error" });
      if (!failed) throw new Error("Failed reply was not persisted");
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);

      const replyTurnId = crypto.randomUUID();
      const started = await rig.orchestrator.retryReply({
        threadId: rig.threadId,
        failedTurnId: failed.id as never,
        replyTurnId: replyTurnId as never,
      });
      await processDetachedWork.drain();
      const replayed = await rig.repos.turns.findById(replyTurnId as never);
      if (!replayed) throw new Error("Retry reply was not persisted");
      const duplicate = await rig.orchestrator.retryReply({
        threadId: rig.threadId,
        failedTurnId: failed.id as never,
        replyTurnId: replyTurnId as never,
      });

      const comparable = (request: (typeof requests)[number]) => {
        const { correlation: _correlation, signal: _signal, ...input } = request;
        return input;
      };
      expect(started.created).toBe(true);
      expect(duplicate).toMatchObject({ created: false, turn: { id: replyTurnId } });
      expect(replayed).toMatchObject({
        id: replyTurnId,
        role: "assistant",
        status: "error",
        prevTurnId: failed.id,
      });
      expect(replayed.position).toBeGreaterThan(failed.position);
      expect(requests).toHaveLength(2);
      const originalRequest = requests[0];
      const retryRequest = requests[1];
      if (!originalRequest || !retryRequest) throw new Error("Expected both retry requests");
      expect(comparable(retryRequest)).toEqual(comparable(originalRequest));
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
    });

    it("rereads and answers a writer message queued while Retry runs", async () => {
      const gateway = scriptedGateway({ usage: lowUsage, errorAtCall: 1, pauseAt: [2] });
      const rig = await manualFixture({ gateway });
      await rig.delivery.enqueue({
        threadId: rig.threadId,
        intent: "message",
        provenance: { kind: "writer", actorId: rig.ids.user },
        body: { kind: "text", text: "Original request." },
        idempotencyKey: "retry-writer-race-original",
      });
      await drainControls(rig);
      await processDetachedWork.drain();
      const failed = await rig.repos.turns.getLatestByThread(rig.threadId);
      if (!failed) throw new Error("Failed reply was not persisted");

      const retry = await rig.orchestrator.retryReply({
        threadId: rig.threadId,
        failedTurnId: failed.id as never,
        replyTurnId: crypto.randomUUID() as never,
      });
      await gateway.untilGatewayBoundary(2);
      const waiting = await rig.delivery.enqueue({
        threadId: rig.threadId,
        intent: "message",
        provenance: { kind: "writer", actorId: rig.ids.user },
        body: { kind: "text", text: "Arrived during Retry." },
        idempotencyKey: "retry-writer-race-late",
      });
      gateway.release(2);
      const turns = await settled(rig);
      await processDetachedWork.drain();

      expect(retry.created).toBe(true);
      expect(turns).toContainEqual(expect.objectContaining({ id: waiting.id, role: "user" }));
      expect(turns).toContainEqual(
        expect.objectContaining({ role: "assistant", status: "complete", prevTurnId: waiting.id }),
      );
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
    });

    it("rereads and runs a compact queued while Retry runs", async () => {
      const gateway = scriptedGateway({ usage: lowUsage, errorAtCall: 1, pauseAt: [2] });
      const rig = await manualFixture({ gateway });
      await rig.delivery.enqueue({
        threadId: rig.threadId,
        intent: "message",
        provenance: { kind: "writer", actorId: rig.ids.user },
        body: { kind: "text", text: "Original request." },
        idempotencyKey: "retry-compact-race-original",
      });
      await drainControls(rig);
      await processDetachedWork.drain();
      const failed = await rig.repos.turns.getLatestByThread(rig.threadId);
      if (!failed) throw new Error("Failed reply was not persisted");

      const retry = await rig.orchestrator.retryReply({
        threadId: rig.threadId,
        failedTurnId: failed.id as never,
        replyTurnId: crypto.randomUUID() as never,
      });
      await gateway.untilGatewayBoundary(2);
      const compact = await compactControl(rig);
      gateway.release(2);
      const turns = await settled(rig);
      await processDetachedWork.drain();

      expect(retry.created).toBe(true);
      expect(turns).toContainEqual(
        expect.objectContaining({
          role: "compaction",
          metadata: expect.objectContaining({ controlMessageId: compact.id }),
        }),
      );
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
    });

    it("allows only one of two tab Retries to take the run claim", async () => {
      const gateway = scriptedGateway({ usage: lowUsage, errorAtCall: 1, pauseAt: [2] });
      const rig = await manualFixture({ gateway });
      await rig.delivery.enqueue({
        threadId: rig.threadId,
        intent: "message",
        provenance: { kind: "writer", actorId: rig.ids.user },
        body: { kind: "text", text: "Original request." },
        idempotencyKey: "retry-two-tabs-original",
      });
      await drainControls(rig);
      await processDetachedWork.drain();
      const failed = await rig.repos.turns.getLatestByThread(rig.threadId);
      if (!failed) throw new Error("Failed reply was not persisted");
      const winningId = crypto.randomUUID();
      const first = await rig.orchestrator.retryReply({
        threadId: rig.threadId,
        failedTurnId: failed.id as never,
        replyTurnId: winningId as never,
      });
      await gateway.untilGatewayBoundary(2);
      await expect(
        rig.orchestrator.retryReply({
          threadId: rig.threadId,
          failedTurnId: failed.id as never,
          replyTurnId: crypto.randomUUID() as never,
        }),
      ).rejects.toMatchObject({ code: "reply_retry_unavailable" });
      gateway.release(2);
      const turns = await settled(rig);
      await processDetachedWork.drain();

      expect(first.created).toBe(true);
      expect(turns.filter((turn) => turn.id === winningId)).toHaveLength(1);
      expect(gateway.requests).toHaveLength(2);
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
    });

    it("does not let a pending Work refresh block Retry", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const workContext = {
        async renderForThread() {
          return {
            text: "<work_context>current: none (direct writes)</work_context>",
            current: {
              projectId: rig.ids.project as never,
              execution: {
                scope: { workId: crypto.randomUUID() as never, workSlug: null },
                aiWriteMode: "direct" as const,
                draftOwner: null,
              },
            },
          };
        },
      };
      const gateway = scriptedGateway({ usage: lowUsage, errorAtCall: 1 });
      rig = await manualFixture({ gateway, workContext });
      await rig.delivery.enqueue({
        threadId: rig.threadId,
        intent: "message",
        provenance: { kind: "writer", actorId: rig.ids.user },
        body: { kind: "text", text: "Original request." },
        idempotencyKey: "retry-work-refresh-original",
      });
      await drainControls(rig);
      await processDetachedWork.drain();
      const failed = await rig.repos.turns.getLatestByThread(rig.threadId);
      if (!failed) throw new Error("Failed reply was not persisted");
      await rig.delivery.threadChanged(rig.threadId);
      expect(await rig.delivery.selectPending(rig.threadId)).toHaveLength(1);

      const retry = await rig.orchestrator.retryReply({
        threadId: rig.threadId,
        failedTurnId: failed.id as never,
        replyTurnId: crypto.randomUUID() as never,
      });
      await processDetachedWork.drain();
      const turns = await settled(rig);

      expect(retry.created).toBe(true);
      expect(turns).toContainEqual(
        expect.objectContaining({
          role: "user",
          origin: "system",
          metadata: expect.objectContaining({ section: "work_context" }),
        }),
      );
      expect(gateway.requests.length).toBeGreaterThanOrEqual(2);
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
    });

    it("retries a crash-orphaned assistant after ordinary orphan repair", async () => {
      const rig = await manualFixture({ gateway: scriptedGateway({ usage: lowUsage }) });
      const previous = await rig.repos.turns.getLatestByThread(rig.threadId);
      if (!previous) throw new Error("Expected fixture history");
      const orphan = await rig.repos.turns.create({
        threadId: rig.threadId,
        prevTurnId: previous.id,
        role: "assistant",
        origin: "assistant",
        status: "pending",
      });
      await expect(
        rig.orchestrator.prepare({ threadId: rig.threadId, drain: true }),
      ).rejects.toMatchObject({
        name: "NoPendingWakeError",
      });
      await processDetachedWork.drain();
      const failed = await rig.repos.turns.findById(orphan.id as never);
      expect(failed).toMatchObject({
        status: "error",
        error: "This response failed.",
        metadata: { reason: "orphaned" },
      });

      const retry = await rig.orchestrator.retryReply({
        threadId: rig.threadId,
        failedTurnId: orphan.id as never,
        replyTurnId: crypto.randomUUID() as never,
      });
      await processDetachedWork.drain();
      expect(retry.created).toBe(true);
      expect(await rig.repos.turns.findById(retry.turn.id)).toMatchObject({ status: "complete" });
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
    });

    it("acknowledges a crashed reply's adopted messages and leaves queued work for Retry", async () => {
      const gateway = scriptedGateway({ usage: lowUsage });
      const rig = await manualFixture({ gateway });
      const previous = await rig.repos.turns.getLatestByThread(rig.threadId);
      if (!previous) throw new Error("Expected fixture history");
      const adopted = [];
      let prevTurnId = previous.id;
      for (const [index, text] of ["first adopted", "second adopted"].entries()) {
        const id = crypto.randomUUID();
        const message = await rig.delivery.enqueue({
          id,
          threadId: rig.threadId,
          intent: "message",
          provenance: { kind: "writer", actorId: rig.ids.user },
          body: { kind: "text", text },
          idempotencyKey: `crash-adopted-${index}`,
        });
        const turn = await rig.repos.turns.create({
          id: id as never,
          threadId: rig.threadId,
          prevTurnId,
          role: "user",
          origin: "writer",
          status: "complete",
        });
        await rig.repos.blocks.create({
          turnId: turn.id,
          blockType: "text",
          sequence: 0,
          content: text,
          textContent: text,
          status: "complete",
        });
        adopted.push({ message, turn });
        prevTurnId = turn.id;
      }
      const orphan = await rig.repos.turns.create({
        threadId: rig.threadId,
        prevTurnId: adopted[1]?.turn.id,
        role: "assistant",
        origin: "assistant",
        status: "streaming",
      });
      const queued = await rig.delivery.enqueue({
        threadId: rig.threadId,
        intent: "message",
        provenance: { kind: "writer", actorId: rig.ids.user },
        body: { kind: "text", text: "queued behind the crashed reply" },
        idempotencyKey: "crash-queued-behind",
      });
      const staleAt = new Date(Date.now() - 60_000);
      await db.insert(schema.threadRunLeases).values({
        threadId: rig.threadId,
        runId: "crashed-run",
        turnId: orphan.id,
        boundTurnIds: [orphan.id],
        adoptedMessageIds: adopted.map(({ message }) => message.id),
        holderId: "dead-worker",
        acquiredAt: staleAt,
        renewedAt: staleAt,
        expiresAt: staleAt,
      });

      const replacement = createDrizzleRunClaim(db, { holderId: "replacement-worker" });
      const delivery = createTestDrizzleDelivery(db, {
        repos: rig.repos,
        eventWriter: rig.eventWriter,
        runClaim: replacement,
      });
      const repairLease = await replacement.startExecution(rig.threadId, "repair-run");
      if (!repairLease) throw new Error("Expected replacement run claim");
      await delivery.repairOrphanedTurns(repairLease);
      await replacement.release(repairLease);

      expect(await rig.repos.turns.findById(orphan.id)).toMatchObject({
        status: "error",
        error: "This response failed.",
        metadata: { reason: "orphaned" },
      });
      expect(await delivery.selectPending(rig.threadId)).toEqual([
        expect.objectContaining({ id: queued.id }),
      ]);

      const recovery = createOrchestrator({ ...rig.deps, runClaim: replacement, delivery });
      const retry = await recovery.retryReply({
        threadId: rig.threadId,
        failedTurnId: orphan.id as never,
        replyTurnId: crypto.randomUUID() as never,
      });
      await processDetachedWork.drain();

      expect(retry.created).toBe(true);
      expect(await rig.repos.turns.findById(retry.turn.id)).toMatchObject({ status: "complete" });
      expect(gateway.requests).toHaveLength(1);
      expect(await delivery.selectPending(rig.threadId)).toEqual([]);
    });

    it("settles and acknowledges a shutdown reply, which is retryable after restart", async () => {
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let call = 0;
      const gateway = scriptedGateway({ usage: lowUsage });
      gateway.stream = async function* (request) {
        call++;
        gateway.requests.push(request);
        if (call === 1) {
          markStarted();
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) resolve();
            else request.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        yield {
          type: "end",
          result: {
            content: [{ type: "text", text: call === 1 ? "partial" : "retried" }],
            toolCalls: [],
            finishReason: "end_turn",
            usage: lowUsage,
            model: "gpt-4.1-mini",
            provider: "openai",
          },
        };
      };
      const gatewayWithSettlement = gateway as ReturnType<typeof scriptedGateway> &
        Pick<Gateway, "settleCancelledResult">;
      gatewayWithSettlement.settleCancelledResult = async ({ result }) =>
        result ? { result, persist: true } : null;
      const rig = await manualFixture({ gateway });
      const message = await rig.delivery.enqueue({
        threadId: rig.threadId,
        intent: "message",
        provenance: { kind: "writer", actorId: rig.ids.user },
        body: { kind: "text", text: "Reply during deployment." },
        idempotencyKey: "shutdown-reply-message",
      });
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      const execution = run.execute();
      await started;
      rig.orchestrator.beginShutdown();
      await expect(execution).resolves.toMatchObject({
        status: "error",
        turn: {
          status: "error",
          error: "This response failed.",
          metadata: { reason: "shutdown" },
        },
      });
      await processDetachedWork.drain();

      expect(await rig.repos.modelResponses.listByTurn(run.executionTurnId)).toHaveLength(1);
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
      expect(await rig.repos.turns.findById(message.id as never)).toMatchObject({ role: "user" });
      await expect(
        rig.orchestrator.retryReply({
          threadId: rig.threadId,
          failedTurnId: run.executionTurnId as never,
          replyTurnId: crypto.randomUUID() as never,
        }),
      ).rejects.toThrow("runtime_shutting_down");
      rig.deps.shutdown.started = false;
      const interrupted = await rig.repos.turns.getLatestByThread(rig.threadId);
      if (!interrupted) throw new Error("Shutdown reply was not persisted");
      const retry = await rig.orchestrator.retryReply({
        threadId: rig.threadId,
        failedTurnId: interrupted.id as never,
        replyTurnId: crypto.randomUUID() as never,
      });
      await processDetachedWork.drain();

      expect(retry.created).toBe(true);
      expect(await rig.repos.turns.findById(retry.turn.id)).toMatchObject({ status: "complete" });
    });

    it("does not allow Retry for a successful reply", async () => {
      const rig = await manualFixture();
      const completed = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        userText: "successful reply",
      });
      await completed.execute();
      await expect(
        rig.orchestrator.retryReply({
          threadId: rig.threadId,
          failedTurnId: completed.executionTurnId as never,
          replyTurnId: crypto.randomUUID() as never,
        }),
      ).rejects.toMatchObject({ code: "reply_retry_unavailable" });
      expect(await rig.runClaim.holder(rig.threadId)).toBeNull();
    });

    it("does not allow Retry for a superseded failed reply", async () => {
      const failedGateway = scriptedGateway({ usage: lowUsage, errorAtCall: 1 });
      const failedRig = await manualFixture({ gateway: failedGateway });
      await failedRig.delivery.enqueue({
        threadId: failedRig.threadId,
        intent: "message",
        provenance: { kind: "writer", actorId: failedRig.ids.user },
        body: { kind: "text", text: "failed reply" },
        idempotencyKey: "failed-reply-before-new-turn",
      });
      await drainControls(failedRig);
      await processDetachedWork.drain();
      const failed = await failedRig.repos.turns.getLatestByThread(failedRig.threadId);
      if (!failed) throw new Error("Failed reply was not persisted");
      const later = await failedRig.repos.turns.create({
        threadId: failedRig.threadId,
        prevTurnId: failed?.id as never,
        role: "system",
        origin: "system",
        status: "complete",
      });
      expect(later).toBeTruthy();
      await expect(
        failedRig.orchestrator.retryReply({
          threadId: failedRig.threadId,
          failedTurnId: failed.id as never,
          replyTurnId: crypto.randomUUID() as never,
        }),
      ).rejects.toMatchObject({ code: "reply_retry_unavailable" });
    });

    it("rechecks the failed leaf after taking the Retry claim", async () => {
      const rig = await manualFixture({
        gateway: scriptedGateway({ usage: lowUsage, errorAtCall: 1 }),
      });
      await rig.delivery.enqueue({
        threadId: rig.threadId,
        intent: "message",
        provenance: { kind: "writer", actorId: rig.ids.user },
        body: { kind: "text", text: "failed reply before claim race" },
        idempotencyKey: "retry-claim-race-failure",
      });
      await drainControls(rig);
      await processDetachedWork.drain();
      const failed = await rig.repos.turns.getLatestByThread(rig.threadId);
      if (!failed) throw new Error("Failed reply was not persisted");

      const startExecution = rig.runClaim.startExecution.bind(rig.runClaim);
      rig.runClaim.startExecution = async (threadId, runId) => {
        await rig.repos.turns.create({
          threadId: rig.threadId,
          prevTurnId: failed.id,
          role: "system",
          origin: "system",
          status: "complete",
        });
        return startExecution(threadId, runId);
      };

      await expect(
        rig.orchestrator.retryReply({
          threadId: rig.threadId,
          failedTurnId: failed.id as never,
          replyTurnId: crypto.randomUUID() as never,
        }),
      ).rejects.toMatchObject({ code: "reply_retry_unavailable" });
      expect(await rig.runClaim.holder(rig.threadId)).toBeNull();
    });

    it("does not allow Retry while the thread claim is held", async () => {
      const busyRig = await manualFixture({
        gateway: scriptedGateway({ usage: lowUsage, errorAtCall: 1 }),
      });
      await busyRig.delivery.enqueue({
        threadId: busyRig.threadId,
        intent: "message",
        provenance: { kind: "writer", actorId: busyRig.ids.user },
        body: { kind: "text", text: "busy retry" },
        idempotencyKey: "busy-failed-reply",
      });
      await drainControls(busyRig);
      await processDetachedWork.drain();
      const busyFailed = await busyRig.repos.turns.getLatestByThread(busyRig.threadId);
      if (!busyFailed) throw new Error("Failed reply was not persisted");
      const held = await busyRig.runClaim.startExecution(busyRig.threadId, crypto.randomUUID());
      expect(held).toBeTruthy();
      if (!held) throw new Error("Expected the test to hold the thread claim");
      await expect(
        busyRig.orchestrator.retryReply({
          threadId: busyRig.threadId,
          failedTurnId: busyFailed.id as never,
          replyTurnId: crypto.randomUUID() as never,
        }),
      ).rejects.toMatchObject({ code: "reply_retry_unavailable" });
      await busyRig.runClaim.release(held);
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
      await processDetachedWork.drain();
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

    it("a failed manual summary does not fail a reply behind a Stop-stamped command", async () => {
      const gateway = scriptedGateway({ usage: lowUsage, pauseAt: [1] });
      const summarizer = scriptedSummarizer(async () => ({
        kind: "failed",
        error: new Error("summary failed"),
        modelResponses: [],
      }));
      const rig = await manualFixture({ gateway, summarizer });
      const active = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        userText: "reply before Stop",
      });
      const execution = active.execute();
      await gateway.untilGatewayBoundary(1);

      await compactControl(rig);
      const waiting = await rig.send(rig.threadId, "reply after failed compact");
      expect(await rig.orchestrator.cancel(rig.threadId, active.executionTurnId)).toBe("cancelled");
      gateway.release(1);
      await execution;
      const turns = await settled(rig);

      expect(turns.find((turn) => turn.role === "compaction")).toMatchObject({
        status: "error",
        metadata: { reason: "compaction_failed", phase: "summary" },
      });
      expect(turns.find((turn) => turn.id === waiting.userTurnId)?.role).toBe("user");
      expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
      expect(JSON.stringify(gateway.requests.at(-1))).toContain("reply after failed compact");
    });

    it("a manual successor exception fails C but continues the queued reply", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const summarizer = scriptedSummarizer(async () => ({
        kind: "complete",
        text: "Earlier context.",
        model: "summary-model",
        modelResponses: [],
      }));
      rig = await manualFixture({ summarizer });
      await (
        await rig.orchestrator.prepare({
          threadId: rig.threadId,
          userText: "Build a compactable tail.",
        })
      ).execute();
      await settled(rig);
      const control = await compactControl(rig);
      let queuedReplyId = "";
      const split = rig.delivery.splitAndContinue.bind(rig.delivery);
      let failed = false;
      rig.delivery.splitAndContinue = async (input) => {
        if (!failed && input.current.kind === "placeholder") {
          failed = true;
          throw new Error("successor unavailable once");
        }
        return split(input);
      };
      const enqueue = summarizer.summarize.bind(summarizer);
      summarizer.summarize = async (input) => {
        const result = await enqueue(input);
        const queued = await rig.delivery.enqueue({
          threadId: rig.threadId,
          intent: "message",
          provenance: { kind: "writer", actorId: rig.ids.user },
          body: { kind: "text", text: "reply survives successor exception" },
          idempotencyKey: "reply-survives-successor-exception",
        });
        queuedReplyId = queued.id;
        return result;
      };

      const outcome = await drainControls(rig);
      expect(outcome.status).toBe("complete");
      const turns = await settled(rig);
      expect(failed).toBe(true);
      const queuedReply = turns.find((turn) => turn.id === queuedReplyId);
      const answer = turns.find(
        (turn) => turn.role === "assistant" && turn.prevTurnId === queuedReply?.id,
      );
      expect(turns.find((turn) => turn.role === "compaction")).toMatchObject({
        status: "error",
        metadata: { controlMessageId: control.id },
      });
      expect(queuedReply).toMatchObject({ role: "user", status: "complete" });
      expect(answer).toMatchObject({ role: "assistant", status: "complete" });
      expect(JSON.stringify(rig.gateway.requests.at(-1))).toContain(
        "reply survives successor exception",
      );
    });

    it("enqueueing the same command id is a no-op before and after execution", async () => {
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

    it("#619 refuses manual compaction below the compactable floor without billing", async () => {
      const rig = await manualFixture({ history: "A short planning note." });
      await (
        await rig.orchestrator.prepare({
          threadId: rig.threadId,
          userText: "Read the latest chapter.",
        })
      ).execute();
      await settled(rig);
      const balance = await rig.creditLedger.getBalance({ userId: rig.ids.user });
      await compactControl(rig);
      await drainControls(rig);
      const turn = (await settled(rig)).at(-1);
      if (!turn) throw new Error("Expected the manual compaction turn");
      expect(turn).toMatchObject({
        role: "compaction",
        status: "error",
        metadata: { reason: "nothing_to_compact", phase: "initial_prepare" },
      });
      expect(rig.summarizer.calls).toHaveLength(0);
      expect(await rig.repos.modelResponses.listByTurn(turn.id)).toEqual([]);
      expect(await rig.creditLedger.getBalance({ userId: rig.ids.user })).toBe(balance);
    });

    it("a control-only sweep starts an idle thread", async () => {
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

    it("a manual minimal tail over the usable window calls no summarizer", async () => {
      const gateway = scriptedGateway({ usage: lowUsage, pauseAt: [1] });
      const rig = await manualFixture({ gateway });
      const active = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        userText: "reply before compact",
      });
      const execution = active.execute();
      await gateway.untilGatewayBoundary(1);
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
      const control = await compactControl(rig);
      await rig.send(rig.threadId, "unanswered ".repeat(1000));
      expect(await rig.orchestrator.cancel(rig.threadId, active.executionTurnId)).toBe("cancelled");
      gateway.release(1);
      await execution;
      await settled(rig);

      const c = (await rig.repos.turns.listByThread(rig.threadId)).find(
        (turn) =>
          turn.role === "compaction" &&
          (turn.metadata as { controlMessageId?: string } | null)?.controlMessageId === control.id,
      );
      expect(c).toMatchObject({
        status: "error",
        metadata: { reason: "context_too_large", phase: "initial_prepare" },
      });
      expect(rig.summarizer.calls).toHaveLength(0);
    });

    it("materializing idle work finalizes an orphan before touching the inbox", async () => {
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

    it("a remote Stop during manual summary wakes the owner after release", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const remote = createDrizzleRunClaim(db, { holderId: "remote-controller" });
      const summarizer = scriptedSummarizer(async ({ owner: { turnId } }) => {
        await rig.delivery.enqueue({
          threadId: rig.threadId,
          intent: "message",
          provenance: { kind: "writer", actorId: rig.ids.user },
          body: { kind: "text", text: "hi after remote Stop" },
          idempotencyKey: "hi-after-remote-stop",
        });
        expect(await remote.cancelExecution(rig.threadId, turnId)).toBe(true);
        return {
          kind: "complete",
          text: "Earlier context.",
          model: "summary-model",
          modelResponses: [],
        };
      });
      rig = await manualFixture({ summarizer });
      await (
        await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "Continue." })
      ).execute();
      await settled(rig);
      await compactControl(rig);

      const outcome = await drainControls(rig);
      expect(outcome.status).toBe("cancelled");
      const turns = await settled(rig);
      expect(turns.find((turn) => turn.role === "compaction")?.status).toBe("cancelled");
      expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
      expect(JSON.stringify(rig.gateway.requests.at(-1))).toContain("hi after remote Stop");
    });

    it("a crash while a command runs leaves one interrupted divider and does not rerun it", async () => {
      const rig = await manualFixture();
      await (
        await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "Continue." })
      ).execute();
      await settled(rig);
      const control = await compactControl(rig);
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });

      // Drop the owning DB session after the command's start commit, as a process crash does.
      await rig.runClaim.release({
        threadId: rig.threadId,
        runId: run.runId,
        holderId: "fixture-owner",
      });
      const replacement = createDrizzleRunClaim(db);
      const delivery = createTestDrizzleDelivery(db, {
        repos: rig.repos,
        eventWriter: rig.eventWriter,
        runClaim: replacement,
      });
      const recovery = createOrchestrator({ ...rig.deps, runClaim: replacement, delivery });

      await expect(recovery.prepare({ threadId: rig.threadId, drain: true })).rejects.toThrow(
        "no_pending_wake",
      );
      const compactions = (await rig.repos.turns.listByThread(rig.threadId)).filter(
        (turn) => turn.role === "compaction",
      );
      expect(compactions).toHaveLength(1);
      expect(compactions[0]).toMatchObject({
        status: "error",
        error: "This conversation couldn't be compacted. Try again.",
        metadata: { reason: "interrupted", phase: "recovery", controlMessageId: control.id },
      });
      expect(await delivery.selectPending(rig.threadId)).toEqual([]);
    });

    it("a crash while a command waits leaves it queued for the next run", async () => {
      const rig = await manualFixture();
      const lease = await rig.runClaim.hold(rig.threadId);
      if (!lease) throw new Error("expected the simulated pre-crash run claim");
      const control = await compactControl(rig);
      expect(await rig.delivery.selectPending(rig.threadId)).toContainEqual(
        expect.objectContaining({ id: control.id }),
      );

      // The queued row survives the process that held the thread claim.
      await lease.release();
      const replacement = createDrizzleRunClaim(db);
      const delivery = createTestDrizzleDelivery(db, {
        repos: rig.repos,
        eventWriter: rig.eventWriter,
        runClaim: replacement,
      });
      const recovery = createOrchestrator({ ...rig.deps, runClaim: replacement, delivery });
      const run = await recovery.prepare({ threadId: rig.threadId, drain: true });
      await run.execute();

      const compaction = (await rig.repos.turns.listByThread(rig.threadId)).find(
        (turn) => turn.role === "compaction",
      );
      expect(compaction).toMatchObject({
        status: "error",
        error: "There is nothing to compact yet.",
        metadata: {
          trigger: "manual",
          controlMessageId: control.id,
          reason: "nothing_to_compact",
        },
      });
      expect(await delivery.selectPending(rig.threadId)).toEqual([]);
    });
  });
