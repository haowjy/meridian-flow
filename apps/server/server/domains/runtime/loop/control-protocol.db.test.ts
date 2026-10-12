/** Control queue ordering, start consumption, and withdrawal against PostgreSQL. */
import type { ThreadPendingInbox, Turn } from "@meridian/contracts/threads";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnStartConflictError } from "../../threads/index.js";
import { createDrizzleRunClaim } from "../adapters/drizzle-run-claim.js";
import { createDrizzleThreadLock } from "../adapters/drizzle-thread-lock.js";
import { createCompactionFixture } from "./__tests__/compaction-db-fixture.js";
import { scriptedSummarizer } from "./__tests__/scripted-summarizer.js";
import {
  createTestDrizzleDelivery,
  createTestOrphanRepair,
} from "./__tests__/test-drizzle-delivery.js";
import { scriptedGateway } from "./__tests__/test-gateway.js";
import { createOrchestrator } from "./orchestrator.js";
import { createRunStarter } from "./run-starter.js";
import { createWakeIfRunnable } from "./wake-if-runnable.js";

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
      instructions?: string,
    ) {
      return rig.delivery.enqueue({
        id,
        threadId: rig.threadId,
        intent: "control",
        provenance: { kind: "writer", actorId: rig.ids.user },
        body: { kind: "compact", ...(instructions ? { instructions } : {}) },
        idempotencyKey: id,
      });
    }

    async function settled(rig: Awaited<ReturnType<typeof fixture>>) {
      await processDetachedWork.drain();
      expect((await rig.runClaim.read(rig.threadId)).kind).toBe("asleep");
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
      expect(rig.activeRuns()).toBe(0);
      return rig.repos.turns.listByThread(rig.threadId);
    }

    async function journal() {
      return db
        .select({ eventType: schema.eventJournal.eventType, payload: schema.eventJournal.payload })
        .from(schema.eventJournal)
        .orderBy(schema.eventJournal.threadId, schema.eventJournal.seq);
    }

    /**
     * A turn's run identity: its row, which must match the turn its journaled
     * start carries (the `RUN_STARTED` payload's source).
     */
    async function identity(turnId: string | undefined) {
      if (!turnId) throw new Error("No turn");
      const [row] = await db
        .select({
          executionId: schema.turns.executionId,
          reservedFor: schema.turns.reservedForUserTurnIds,
        })
        .from(schema.turns)
        .where(eq(schema.turns.id, turnId as never));
      const started = (await journal())
        .filter(({ eventType }) => eventType === "turn.created")
        .map(({ payload }) => (payload as { turn: Turn }).turn)
        .find((turn) => turn.id === turnId);
      const fromRow = {
        executionId: row?.executionId ?? null,
        reservedForUserTurnIds: row?.reservedFor ?? [],
      };
      expect({
        executionId: started?.executionId ?? null,
        reservedForUserTurnIds: started?.reservedForUserTurnIds ?? [],
      }).toEqual(fromRow);
      return fromRow;
    }

    /** The turn that delivered a message, and that `messages.delivered` journaled it once. */
    async function deliveredBy(messageId: string | undefined) {
      if (!messageId) throw new Error("No message");
      const [row] = await db
        .select({
          deliveredAt: schema.threadInboxMessages.deliveredAt,
          byTurnId: schema.threadInboxMessages.deliveredByTurnId,
        })
        .from(schema.threadInboxMessages)
        .where(eq(schema.threadInboxMessages.id, messageId));
      if (!row?.deliveredAt) return undefined;
      const journaled = (await journal())
        .filter(({ eventType }) => eventType === "messages.delivered")
        .map(({ payload }) => payload as { byTurnId: string | null; userTurnIds: string[] })
        .filter(({ userTurnIds }) => userTurnIds.includes(messageId));
      expect(journaled.map(({ byTurnId }) => byTurnId)).toEqual([row.byTurnId]);
      return row.byTurnId;
    }

    /** How many times an execution's end was journaled. */
    async function endsOf(executionId: string | null) {
      return (await journal()).filter(
        ({ eventType, payload }) =>
          eventType === "execution.ended" &&
          (payload as { executionId: string }).executionId === executionId,
      ).length;
    }

    async function drainControls(rig: Awaited<ReturnType<typeof fixture>>) {
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      return run.execute();
    }

    it("rejects compact with its own 409 code until the thread has a completed reply", async () => {
      const rig = await manualFixture({ empty: true });
      await expect(
        rig.delivery.enqueueControl({
          threadId: rig.threadId,
          actorId: rig.ids.user,
          id: crypto.randomUUID(),
          control: { kind: "compact" },
        }),
      ).rejects.toMatchObject(
        expect.objectContaining({
          statusCode: 409,
          message: "compact_requires_completed_reply",
        }),
      );

      const otherThread = await rig.repos.threads.create({
        aiWriteMode: "direct",
        id: crypto.randomUUID(),
        userId: rig.ids.user,
        projectId: rig.ids.project,
      });
      await rig.repos.turns.create({
        threadId: otherThread.id,
        prevTurnId: null,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      const conflictingId = crypto.randomUUID();
      await rig.delivery.enqueueControl({
        threadId: otherThread.id,
        actorId: rig.ids.user,
        id: conflictingId,
        control: { kind: "compact" },
      });
      await expect(
        rig.delivery.enqueueControl({
          threadId: rig.threadId,
          actorId: rig.ids.user,
          id: conflictingId,
          control: { kind: "compact" },
        }),
      ).rejects.toMatchObject({ statusCode: 409, message: "control_id_conflict" });

      await (
        await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "Complete a reply." })
      ).execute();
      await expect(
        rig.delivery.enqueueControl({
          threadId: rig.threadId,
          actorId: rig.ids.user,
          id: crypto.randomUUID(),
          control: { kind: "compact" },
        }),
      ).resolves.toMatchObject({ created: true });
    });

    it("honors completed replies across bounded fork-of-fork lineage", async () => {
      const rig = await manualFixture({ empty: true });
      const source = await rig.repos.threads.findById(rig.threadId);
      if (!source) throw new Error("Expected source thread");
      const request = await rig.repos.turns.create({
        threadId: source.id,
        prevTurnId: null,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      const answer = await rig.repos.turns.create({
        threadId: source.id,
        prevTurnId: request.id,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      const forkAtRequest = (
        await rig.repos.threads.createDerivedPrimary({
          aiWriteMode: "direct",
          id: crypto.randomUUID(),
          source,
          workId: source.workId,
          userId: source.userId,
          projectId: source.projectId,
          originType: "fork",
          originTurnId: request.id,
        })
      ).thread;

      await expect(
        rig.delivery.enqueueControl({
          threadId: forkAtRequest.id,
          actorId: rig.ids.user,
          id: crypto.randomUUID(),
          control: { kind: "compact" },
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "compact_requires_completed_reply",
      });

      const firstFork = (
        await rig.repos.threads.createDerivedPrimary({
          aiWriteMode: "direct",
          id: crypto.randomUUID(),
          source,
          workId: source.workId,
          userId: source.userId,
          projectId: source.projectId,
          originType: "fork",
          originTurnId: answer.id,
        })
      ).thread;
      const firstForkRequest = await rig.repos.turns.create({
        threadId: firstFork.id,
        prevTurnId: answer.id,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      const secondFork = (
        await rig.repos.threads.createDerivedPrimary({
          aiWriteMode: "direct",
          id: crypto.randomUUID(),
          source: firstFork,
          workId: firstFork.workId,
          userId: firstFork.userId,
          projectId: firstFork.projectId,
          originType: "fork",
          originTurnId: firstForkRequest.id,
        })
      ).thread;

      await expect(
        rig.delivery.enqueueControl({
          threadId: secondFork.id,
          actorId: rig.ids.user,
          id: crypto.randomUUID(),
          control: { kind: "compact" },
        }),
      ).resolves.toMatchObject({ created: true });
    });

    it("returns the compact refusal when a fork cutoff is missing", async () => {
      const rig = await manualFixture();
      const source = await rig.repos.threads.findById(rig.threadId);
      const answer = (await rig.repos.turns.listByThread(rig.threadId)).find(
        (turn) => turn.role === "assistant" && turn.status === "complete",
      );
      if (!source || !answer) throw new Error("Expected source thread and completed reply");
      const { thread: fork } = await rig.repos.threads.createDerivedPrimary({
        aiWriteMode: "direct",
        id: crypto.randomUUID(),
        source,
        workId: source.workId,
        userId: source.userId,
        projectId: source.projectId,
        originType: "fork",
        originTurnId: answer.id,
      });
      const findTurn = rig.repos.turns.findById.bind(rig.repos.turns);
      rig.repos.turns.findById = async (id) => (id === answer.id ? null : findTurn(id));

      await expect(
        rig.delivery.enqueueControl({
          threadId: fork.id,
          actorId: rig.ids.user,
          id: crypto.randomUUID(),
          control: { kind: "compact" },
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "compact_requires_completed_reply",
      });
    });

    it.each([2])("fails once and acknowledges %i adopted message(s)", async (messageCount) => {
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

    it("Retry replays the original request, appends after failure, is idempotent, and refuses the superseded original", async () => {
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
      // The Retry is reserved for the failed reply's messages, in a new execution.
      const retried = await identity(replyTurnId);
      expect(retried.reservedForUserTurnIds).toEqual(
        (await identity(failed.id)).reservedForUserTurnIds,
      );
      expect(retried.reservedForUserTurnIds).toEqual([failed.prevTurnId]);
      expect(retried.executionId).not.toBe((await identity(failed.id)).executionId);
      expect(started.executionId).toBe(retried.executionId);
      expect(duplicate).toMatchObject({
        created: false,
        turn: { id: replyTurnId },
        executionId: retried.executionId,
      });
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

      // Every Retry precondition except the failed leaf still holds for the original.
      expect(await rig.repos.turns.findById(failed.id)).toMatchObject({
        threadId: rig.threadId,
        role: "assistant",
        status: "error",
      });
      expect((await rig.repos.turns.getLatestByThread(rig.threadId))?.id).toBe(replyTurnId);
      expect((await rig.runClaim.read(rig.threadId)).kind).toBe("asleep");
      expect(rig.orchestrator.isThreadRunning(rig.threadId)).toBe(false);
      await expect(
        rig.orchestrator.retryReply({
          threadId: rig.threadId,
          failedTurnId: failed.id as never,
          replyTurnId: crypto.randomUUID() as never,
        }),
      ).rejects.toMatchObject({ code: "reply_retry_unavailable" });
      expect(requests).toHaveLength(2);
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
        executionId: "crashed-run",
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
      const repairLease = await replacement.startExecution(rig.threadId, crypto.randomUUID(), () =>
        delivery.settleStaleExecution(rig.threadId),
      );
      if (!repairLease) throw new Error("Expected replacement run claim");
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
      expect(await rig.repos.turns.findById(retry.turn?.id as never)).toMatchObject({
        status: "complete",
      });
      expect(gateway.requests).toHaveLength(1);
      expect(await delivery.selectPending(rig.threadId)).toEqual([]);
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
      rig.runClaim.startExecution = async (threadId, executionId, settle) => {
        await rig.repos.turns.create({
          threadId: rig.threadId,
          prevTurnId: failed.id,
          role: "system",
          origin: "system",
          status: "complete",
        });
        return startExecution(threadId, executionId, settle);
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

    it("adopts A and B across a queued command at a tool boundary, then compacts", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const gateway = scriptedGateway({
        usage: lowUsage,
        results: [
          {
            content: [
              {
                type: "tool_use",
                toolCallId: "queue-order-boundary",
                toolName: "unavailable_probe_tool",
                input: {},
              },
            ],
            toolCalls: [],
            finishReason: "tool_use",
            usage: lowUsage,
            model: "gpt-4.1-mini",
            provider: "openai",
          },
        ],
        onStream: async (call) => {
          if (call !== 1) return;
          await rig.send(rig.threadId, "A before queued compact");
          await compactControl(rig);
          await rig.send(rig.threadId, "B after queued compact");
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
        "user",
        "assistant",
        "compaction",
      ]);
      expect(tail.slice(1).map((turn) => turn.prevTurnId)).toEqual(
        tail.slice(0, -1).map((turn) => turn.id),
      );
      expect(JSON.stringify(gateway.requests[1])).toContain("A before queued compact");
      expect(JSON.stringify(gateway.requests[1].messages.at(-1))).toContain(
        "B after queued compact",
      );
      expect(tail.find((turn) => turn.role === "compaction")?.metadata).toMatchObject({
        trigger: "manual",
      });
    });

    it("answers B in the next run before compacting when B arrives after the last boundary", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const gateway = scriptedGateway({
        usage: lowUsage,
        onStream: async (call) => {
          if (call !== 1) return;
          await rig.send(rig.threadId, "A before queued compact");
          await compactControl(rig);
          await rig.send(rig.threadId, "B after the last boundary");
        },
      });
      rig = await manualFixture({ gateway });
      const start = (await rig.repos.turns.listByThread(rig.threadId)).length;

      await (
        await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "first reply" })
      ).execute();
      const tail = (await settled(rig)).slice(start);

      expect(gateway.requests).toHaveLength(2);
      expect(JSON.stringify(gateway.requests[1].messages.at(-1))).toContain(
        "B after the last boundary",
      );
      expect(tail.map((turn) => turn.role)).toEqual([
        "user",
        "assistant",
        "user",
        "user",
        "assistant",
        "compaction",
      ]);
      expect(tail.slice(1).map((turn) => turn.prevTurnId)).toEqual(
        tail.slice(0, -1).map((turn) => turn.id),
      );
      const reply0 = tail[1];
      const messageA = tail[2];
      const messageB = tail[3];
      expect(messageA?.position).toBeGreaterThan(reply0?.position ?? -1);
      expect(messageB?.position).toBeGreaterThan(reply0?.position ?? -1);
      const compaction = tail.find((turn) => turn.role === "compaction");
      const answeringReply = [...tail].reverse().find((turn) => turn.role === "assistant");
      expect(compaction?.position).toBeGreaterThan(answeringReply?.position ?? -1);
    });

    it("Stop answers waiting B before compacting", async () => {
      const gateway = scriptedGateway({ usage: lowUsage, pauseAt: [1] });
      const rig = await manualFixture({ gateway });
      const active = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        userText: "reply to stop",
      });
      const execution = active.execute();
      await gateway.untilGatewayBoundary(1);

      await rig.send(rig.threadId, "A before queued compact");
      const control = await compactControl(rig);
      await rig.send(rig.threadId, "B after queued compact");
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
        },
      });
      expect(JSON.stringify(gateway.requests[1])).toContain("A before queued compact");
      expect(JSON.stringify(gateway.requests[1].messages.at(-1))).toContain(
        "B after queued compact",
      );
      const relevant = turns.filter(
        (turn) =>
          turn.role === "user" ||
          turn.role === "assistant" ||
          (turn.metadata as { controlMessageId?: string } | null)?.controlMessageId === control.id,
      );
      expect(command?.position).toBeGreaterThan(relevant.at(-2)?.position ?? -1);
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
    });

    it("runs queued controls one per run and in their queue order", async () => {
      const rig = await manualFixture();
      await (
        await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "History to compact." })
      ).execute();
      await settled(rig);
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
      expect(controls.map((turn) => turn.status)).toEqual(["complete", "complete"]);
      expect(rig.summarizer.calls).toHaveLength(2);
      expect(rig.summarizer.calls[1].projection.blocks[0]?.textContent).toContain(
        "Earlier context.",
      );
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
    });

    it("withdrawal is replay-safe before start and refused after start", async () => {
      const rig = await manualFixture();
      const withdrawn = await compactControl(rig);
      await rig.send(rig.threadId, "B behind withdrawn compact");
      expect(await rig.delivery.withdrawControl(rig.threadId, withdrawn.id)).toEqual({
        outcome: "withdrawn",
      });
      expect(await rig.delivery.withdrawControl(rig.threadId, withdrawn.id)).toEqual({
        outcome: "withdrawn",
      });
      await drainControls(rig);
      expect(JSON.stringify(rig.gateway.requests.at(-1)?.messages.at(-1))).toContain(
        "B behind withdrawn compact",
      );

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
        error: "This conversation couldn't be compacted. Try again.",
        metadata: { reason: "context_too_large", phase: "initial_prepare" },
      });
      const journal = await db
        .select({ eventType: schema.eventJournal.eventType, payload: schema.eventJournal.payload })
        .from(schema.eventJournal);
      expect(journal).toContainEqual({
        eventType: "turn.error",
        payload: expect.objectContaining({
          error: expect.objectContaining({
            message: "This message is too long for this chat's model.",
            details: expect.objectContaining({
              reason: "context_too_large",
              phase: "initial_prepare",
            }),
          }),
        }),
      });
      expect(rig.summarizer.calls).toHaveLength(0);
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
        executionId: run.executionId,
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

    it("a crash while a command waits preserves queue order for the next runs", async () => {
      const rig = await manualFixture();
      const lease = await rig.runClaim.hold(rig.threadId);
      if (!lease) throw new Error("Expected the simulated pre-crash run claim");
      const message = await rig.delivery.enqueue({
        threadId: rig.threadId,
        intent: "message",
        provenance: { kind: "writer", actorId: rig.ids.user },
        body: { kind: "text", text: "Answer this before compacting." },
        idempotencyKey: "queued-before-crash-command",
      });
      const control = await rig.delivery.enqueueControl({
        threadId: rig.threadId,
        actorId: rig.ids.user,
        id: crypto.randomUUID(),
        control: { kind: "compact" },
      });
      expect((await rig.delivery.selectPending(rig.threadId)).map(({ id }) => id)).toEqual([
        message.id,
        control.response.id,
      ]);

      // The queued rows survive the process that held the thread claim.
      await lease.release();
      const replacement = createDrizzleRunClaim(db);
      const delivery = createTestDrizzleDelivery(db, {
        repos: rig.repos,
        eventWriter: rig.eventWriter,
        runClaim: replacement,
      });
      const recovery = createOrchestrator({ ...rig.deps, runClaim: replacement, delivery });

      await (await recovery.prepare({ threadId: rig.threadId, drain: true })).execute();
      expect(JSON.stringify(rig.gateway.requests.at(-1))).toContain(
        "Answer this before compacting.",
      );
      expect((await delivery.selectPending(rig.threadId)).map(({ id }) => id)).toEqual([
        control.response.id,
      ]);

      await (await recovery.prepare({ threadId: rig.threadId, drain: true })).execute();
      expect(await delivery.selectPending(rig.threadId)).toEqual([]);
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      const compact = turns.find(
        (turn) =>
          turn.role === "compaction" &&
          (turn.metadata as { controlMessageId?: string } | null)?.controlMessageId ===
            control.response.id,
      );
      expect(compact).toEqual(
        expect.objectContaining({
          role: "compaction",
          status: "complete",
          metadata: expect.objectContaining({ controlMessageId: control.response.id }),
        }),
      );
      const reply = [...turns].reverse().find((turn) => turn.role === "assistant");
      expect(compact?.position).toBeGreaterThan(reply?.position ?? -1);
    });

    describe("write-mode switch", () => {
      type Rig = Awaited<ReturnType<typeof fixture>>;
      const toolUse = {
        content: [
          {
            type: "tool_use" as const,
            toolCallId: "switch-boundary",
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

      function switchMode(rig: Rig, mode: "direct" | "draft", id: string = crypto.randomUUID()) {
        return rig.delivery.enqueueControl({
          threadId: rig.threadId,
          actorId: rig.ids.user,
          id,
          control: { kind: "write_mode", mode },
        });
      }
      const switchTurns = async (rig: Rig) =>
        (await rig.repos.turns.listByThread(rig.threadId)).filter(
          (turn) => (turn.metadata as { kind?: string } | null)?.kind === "write_mode_switch",
        );
      const threadMode = async (rig: Rig) =>
        (await rig.repos.threads.findById(rig.threadId))?.aiWriteMode;

      it("applies at once in an idle chat as one complete switch turn", async () => {
        const rig = await manualFixture();
        const leaf = (await rig.repos.threads.findById(rig.threadId))?.activeLeafTurnId;
        const applied = await switchMode(rig, "draft");

        const [turn] = await switchTurns(rig);
        expect(applied).toMatchObject({
          created: true,
          response: { pending: null, turnId: turn?.id },
        });
        expect(turn).toMatchObject({
          role: "system",
          status: "complete",
          writeMode: "draft",
          prevTurnId: leaf,
          metadata: {
            kind: "write_mode_switch",
            mode: "draft",
            controlMessageId: applied.response.id,
          },
        });
        expect((await rig.repos.blocks.listByTurn(turn?.id as never))[0]?.textContent).toContain(
          "The writer switched this chat to draft mode.",
        );
        expect(await threadMode(rig)).toBe("draft");
        expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
        expect(await rig.delivery.withdrawControl(rig.threadId, applied.response.id)).toEqual({
          outcome: "already_started",
        });
      });

      it("answers a switch a reply's release applies mid-answer as queued or applied, never both null", async () => {
        const rig = await manualFixture();
        const lease = await rig.runClaim.startExecution(
          rig.threadId as never,
          crypto.randomUUID() as never,
          async () => {},
        );
        if (!lease) throw new Error("Expected the reply's run claim");
        // The reply releases and applies S between the route's answer reads.
        // Each read waits until that apply finishes or blocks on the thread lock.
        const blockedOnLock = async () =>
          (
            await db.execute(
              sql`select 1 from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`,
            )
          ).length > 0;
        let betweenReads!: () => void;
        const reached = new Promise<void>((resolve) => {
          betweenReads = resolve;
        });
        let settled = false;
        // Started outside the route's call, so it shares none of its transaction.
        const applied = reached.then(async () => {
          await rig.runClaim.release(lease);
          return rig.delivery.applyDueSwitches(rig.threadId as never).finally(() => {
            settled = true;
          });
        });
        const find = rig.repos.turns.findByControlId.bind(rig.repos.turns);
        vi.spyOn(rig.repos.turns, "findByControlId").mockImplementationOnce(async (...args) => {
          const turn = await find(...args);
          betweenReads();
          await vi.waitFor(
            async () => {
              if (!settled && !(await blockedOnLock())) throw new Error("apply still running");
            },
            { interval: 5, timeout: 5000 },
          );
          return turn;
        });

        const { response } = await switchMode(rig, "draft");
        expect(await applied).toBe(true);
        const [turn] = await switchTurns(rig);

        expect(turn).toBeDefined();
        expect(await threadMode(rig)).toBe("draft");
        // A coherent answer is queued (read before the apply) or applied, never both null.
        expect(response.pending !== null || response.turnId === turn?.id).toBe(true);
      });

      it("ends the reply at the next request boundary for a message behind a queued switch, even out of budget", async () => {
        let rig: Rig;
        let queued: Awaited<ReturnType<typeof switchMode>> | undefined;
        let admitted: Awaited<ReturnType<Rig["send"]>> | undefined;
        const gateway = scriptedGateway({
          usage: lowUsage,
          results: [toolUse],
          onStream: async (call) => {
            if (call !== 1) return;
            // Another tab's switch commits after this send reads the inbox but
            // before it takes the thread lock: the stamp must still say `send`.
            const lock = rig.delivery.withThreadLock;
            vi.spyOn(rig.delivery, "withThreadLock").mockImplementationOnce(async (...args) => {
              queued = await switchMode(rig, "draft");
              return lock(...args);
            });
            admitted = await rig.send(rig.threadId, "M2 behind the switch");
          },
        });
        rig = await manualFixture({ gateway });
        // The budget is spent while the switch waits: only a yield before the
        // budget check keeps A from failing.
        vi.spyOn(rig.deps.billingUsage, "canContinueModelCall").mockImplementation(async () =>
          (await rig.delivery.selectPending(rig.threadId)).every(
            (row) => row.body.kind !== "write_mode",
          ),
        );
        const start = (await rig.repos.turns.listByThread(rig.threadId)).length;

        const outcome = await (
          await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "first reply" })
        ).execute();
        const tail = (await settled(rig)).slice(start);

        expect(queued?.response).toMatchObject({
          pending: { deliveryState: "waiting", control: { kind: "write_mode", mode: "draft" } },
          turnId: null,
        });
        expect(outcome).toMatchObject({ status: "complete" });
        expect(outcome.status === "failed" ? null : outcome.turn).toMatchObject({
          role: "assistant",
          status: "complete",
          finishReason: "end_turn",
        });
        expect(
          tail.map((turn) =>
            turn.role === "system" ? (turn.metadata as { kind: string }).kind : turn.role,
          ),
        ).toEqual(["user", "assistant", "user", "write_mode_switch", "assistant"]);
        expect(tail.slice(1).map((turn) => turn.prevTurnId)).toEqual(
          tail.slice(0, -1).map((turn) => turn.id),
        );
        // A made one request; the next reply answers M2 after the notice.
        expect(gateway.requests).toHaveLength(2);
        const reply = JSON.stringify(gateway.requests[1]?.messages);
        expect(reply.indexOf("The writer switched this chat to draft mode.")).toBeGreaterThan(
          reply.indexOf("M2 behind the switch"),
        );
        expect(tail[2]?.metadata).not.toMatchObject({ delivery: "steer" });
        // M2 does not join A, so admission names no reply: the client learns
        // M2's answer from its RUN_STARTED, never A's id.
        expect(admitted).toMatchObject({ userTurnId: tail[2]?.id, steersTurnId: null });
        expect(tail[4]).toMatchObject({ role: "assistant", status: "complete" });
        // A yielded with M2 undelivered, so A's execution ended and B, in a new
        // execution reserved for M2, delivered it.
        const a = await identity(tail[1]?.id);
        const b = await identity(tail[4]?.id);
        expect(a.reservedForUserTurnIds).toEqual([tail[0]?.id]);
        expect(b.reservedForUserTurnIds).toEqual([tail[2]?.id]);
        expect(b.executionId).not.toBe(a.executionId);
        expect(await deliveredBy(tail[0]?.id)).toBe(tail[1]?.id);
        expect(await deliveredBy(tail[2]?.id)).toBe(tail[4]?.id);
        expect(await endsOf(a.executionId)).toBe(1);
        expect(await endsOf(b.executionId)).toBe(1);
        expect(await threadMode(rig)).toBe("draft");
      });

      it("splits a steered reply into a successor in the same execution", async () => {
        let rig: Rig;
        let admitted: Awaited<ReturnType<Rig["send"]>> | undefined;
        const gateway = scriptedGateway({
          usage: lowUsage,
          results: [toolUse],
          onStream: async (call) => {
            if (call === 1) admitted = await rig.send(rig.threadId, "M2 steers the reply");
          },
        });
        rig = await manualFixture({ gateway });
        const start = (await rig.repos.turns.listByThread(rig.threadId)).length;

        await (
          await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "first reply" })
        ).execute();
        const tail = (await settled(rig)).slice(start);

        expect(tail.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
        // M2 was steered into A, so admission names A; B, in A's execution,
        // is reserved for M2 and delivers it.
        expect(admitted).toMatchObject({ userTurnId: tail[2]?.id, steersTurnId: tail[1]?.id });
        expect(tail[2]?.metadata).toMatchObject({ delivery: "steer" });
        const a = await identity(tail[1]?.id);
        const b = await identity(tail[3]?.id);
        expect(a.executionId).toEqual(expect.any(String));
        expect(b.executionId).toBe(a.executionId);
        expect(a.reservedForUserTurnIds).toEqual([tail[0]?.id]);
        expect(b.reservedForUserTurnIds).toEqual([tail[2]?.id]);
        expect(await deliveredBy(tail[0]?.id)).toBe(tail[1]?.id);
        expect(await deliveredBy(tail[2]?.id)).toBe(tail[3]?.id);
        expect(await endsOf(a.executionId)).toBe(1);
      });

      it("names no reply for a message admitted after the live reply ended and its switch applied", async () => {
        const gateway = scriptedGateway({ usage: lowUsage, pauseAt: [1] });
        const rig = await manualFixture({ gateway });
        const a = await rig.orchestrator.prepare({
          threadId: rig.threadId,
          userText: "first reply",
        });
        const aDone = a.execute();
        await gateway.untilGatewayBoundary();
        await switchMode(rig, "draft");
        // M2 saw A live, then A ends and its release applies the switch before
        // M2 takes the thread lock: M2 is answered by a new reply, not A.
        const lock = rig.delivery.withThreadLock;
        vi.spyOn(rig.delivery, "withThreadLock").mockImplementationOnce(async (...args) => {
          gateway.release();
          await aDone;
          await processDetachedWork.drain();
          expect(await threadMode(rig)).toBe("draft");
          return lock(...args);
        });

        const admitted = await rig.send(rig.threadId, "M2 after A ended");
        expect(admitted.steersTurnId).toBeNull();
        expect(
          (await rig.repos.turns.findById(admitted.userTurnId as never))?.metadata,
        ).not.toMatchObject({ delivery: "steer" });

        await drainControls(rig);
        const turns = await settled(rig);
        const answer = turns.find((turn) => turn.prevTurnId === admitted.userTurnId);
        expect(answer).toMatchObject({ role: "assistant", status: "complete", writeMode: "draft" });
        expect(answer?.id).not.toBe(a.executionTurnId);
      });

      it("re-resolves the live reply when admission retries after that reply ended", async () => {
        const gateway = scriptedGateway({ usage: lowUsage, pauseAt: [1] });
        const rig = await manualFixture({ gateway });
        const a = await rig.orchestrator.prepare({
          threadId: rig.threadId,
          userText: "first reply",
        });
        const aDone = a.execute();
        await gateway.untilGatewayBoundary();
        // The first attempt sees A live and loses its turn start; A ends before
        // the retry takes the lock, so the retry must not join A.
        vi.spyOn(rig.repos, "runTurnStartTransition").mockRejectedValueOnce(
          new TurnStartConflictError(rig.threadId, "already_running"),
        );
        const lock = rig.delivery.withThreadLock;
        let calls = 0;
        vi.spyOn(rig.delivery, "withThreadLock").mockImplementation(async (...args) => {
          if (++calls === 2) {
            gateway.release();
            await aDone;
            await processDetachedWork.drain();
          }
          return lock(...args);
        });

        const admitted = await rig.send(rig.threadId, "M2 retried after A ended");

        expect(calls).toBeGreaterThanOrEqual(2);
        expect(admitted.steersTurnId).toBeNull();
        expect(
          (await rig.repos.turns.findById(admitted.userTurnId as never))?.metadata,
        ).not.toMatchObject({ delivery: "steer" });
      });

      it.each([
        { name: "at final close", results: [], raceEarlyCheck: false },
        {
          name: "when the switch lands after the early check",
          results: [toolUse],
          raceEarlyCheck: true,
        },
      ])("ends the reply with no successor $name", async ({ results, raceEarlyCheck }) => {
        let rig: Rig;
        const gateway = scriptedGateway({
          usage: lowUsage,
          results,
          onStream: async (call) => {
            if (call !== 1) return;
            await switchMode(rig, "draft");
            await rig.send(rig.threadId, "M2 behind the switch");
          },
        });
        rig = await manualFixture({ gateway });
        if (raceEarlyCheck) vi.spyOn(rig.delivery, "yieldsAtBoundary").mockResolvedValueOnce(false);
        const start = (await rig.repos.turns.listByThread(rig.threadId)).length;

        await (
          await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "first reply" })
        ).execute();
        const tail = (await settled(rig)).slice(start);

        expect(
          tail.map((turn) =>
            turn.role === "system" ? (turn.metadata as { kind: string }).kind : turn.role,
          ),
        ).toEqual(["user", "assistant", "user", "write_mode_switch", "assistant"]);
        expect(tail[1]).toMatchObject({ status: "complete" });
        expect(tail.slice(1).map((turn) => turn.prevTurnId)).toEqual(
          tail.slice(0, -1).map((turn) => turn.id),
        );
        expect(gateway.requests).toHaveLength(2);
      });

      it("lets a parent's abort at the yield cancel the reply instead of completing it", async () => {
        let rig: Rig;
        const parent = new AbortController();
        const gateway = scriptedGateway({
          usage: lowUsage,
          results: [toolUse],
          onStream: async (call) => {
            if (call !== 1) return;
            await switchMode(rig, "draft");
            await rig.send(rig.threadId, "M2 behind the switch");
          },
        });
        rig = await manualFixture({ gateway });
        // The parent aborts while the boundary read is in flight; no durable flag is set.
        const yields = rig.delivery.yieldsAtBoundary.bind(rig.delivery);
        vi.spyOn(rig.delivery, "yieldsAtBoundary").mockImplementation(async (id) => {
          const result = await yields(id);
          if (result) parent.abort();
          return result;
        });

        const run = await rig.orchestrator.prepare({
          threadId: rig.threadId,
          userText: "first reply",
          signal: parent.signal,
        });
        await run.execute();
        await settled(rig);

        expect(await rig.repos.turns.findById(run.executionTurnId)).toMatchObject({
          role: "assistant",
          status: "cancelled",
        });
      });

      it("lets a running compaction keep its outcome and leaves the message behind the switch pending", async () => {
        const summarizer = scriptedSummarizer(async () => ({
          kind: "complete",
          text: "Earlier context.",
          model: "summary-model",
          modelResponses: [],
        }));
        const rig = await manualFixture({ summarizer });
        await (
          await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "Build a tail." })
        ).execute();
        await settled(rig);
        const control = await compactControl(rig);
        const summarize = summarizer.summarize.bind(summarizer);
        let queuedMessageId = "";
        summarizer.summarize = async (input) => {
          const result = await summarize(input);
          await switchMode(rig, "draft");
          queuedMessageId = (
            await rig.delivery.enqueue({
              threadId: rig.threadId,
              intent: "message",
              provenance: { kind: "writer", actorId: rig.ids.user },
              body: { kind: "text", text: "M2 behind the switch" },
              idempotencyKey: "m2-behind-switch",
            })
          ).id;
          return result;
        };
        const requestsBefore = rig.gateway.requests.length;

        const outcome = await drainControls(rig);
        // The compaction run released with C as its last turn: no successor.
        expect(outcome.status === "failed" ? null : outcome.turn).toMatchObject({
          role: "compaction",
          status: "complete",
          metadata: { controlMessageId: control.id },
        });
        const turns = await settled(rig);
        const compaction = turns.find((turn) => turn.role === "compaction");
        const [switchTurn] = await switchTurns(rig);
        const message = turns.find((turn) => turn.id === queuedMessageId);
        const answer = turns.find(
          (turn) => turn.role === "assistant" && turn.position > (switchTurn?.position ?? 0),
        );
        expect(compaction?.status).toBe("complete");
        expect(switchTurn?.position).toBeGreaterThan(compaction?.position ?? 0);
        // M2 was never adopted by the compaction run: it joins the graph after the switch.
        expect(message?.prevTurnId).toBe(switchTurn?.id);
        expect(answer).toMatchObject({ status: "complete", prevTurnId: message?.id });
        expect(
          turns.filter(
            (turn) =>
              turn.role === "assistant" &&
              turn.position > (compaction?.position ?? 0) &&
              turn.position < (switchTurn?.position ?? 0),
          ),
        ).toEqual([]);
        expect(rig.gateway.requests.length - requestsBefore).toBe(1);
      });

      it("recovers a crashed automatic compaction with one reply to M1 and M2 after the switch", async () => {
        const rig = await fixture({ gateway: scriptedGateway({ usage: lowUsage }) });
        const run = await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "M1 asks" });
        expect(await rig.repos.turns.findById(run.executionTurnId)).toMatchObject({
          role: "compaction",
          status: "pending",
        });
        await switchMode(rig, "draft");
        await rig.delivery.enqueue({
          threadId: rig.threadId,
          intent: "message",
          provenance: { kind: "writer", actorId: rig.ids.user },
          body: { kind: "text", text: "M2 follows" },
          idempotencyKey: "m2-after-crashed-compaction",
        });
        // A crash drops the claim's DB session but leaves the lease row and its C/[M1] receipt.
        const [lease] = await db
          .select()
          .from(schema.threadRunLeases)
          .where(eq(schema.threadRunLeases.threadId, rig.threadId));
        if (!lease) throw new Error("Expected the compaction's run lease");
        expect(lease.adoptedMessageIds).toEqual([run.userTurnId]);
        await rig.runClaim.release({
          threadId: rig.threadId,
          executionId: run.executionId,
          holderId: "fixture-owner",
        });
        await db.insert(schema.threadRunLeases).values(lease);
        rig.setThreshold(100000);
        // A replacement process: its own claim, delivery, and wake path.
        const replacement = createDrizzleRunClaim(db, { holderId: "replacement-worker" });
        const delivery = createTestDrizzleDelivery(db, {
          repos: rig.repos,
          eventWriter: rig.eventWriter,
          runClaim: replacement,
        });
        let recovery!: ReturnType<typeof createOrchestrator>;
        const wake = createWakeIfRunnable({
          delivery,
          runStarter: createRunStarter(
            {
              applyDueSwitches: delivery.applyDueSwitches,
              startDrain: (id) => recovery.startDrain(id),
            },
            rig.deps.eventSink,
          ),
        });
        recovery = createOrchestrator({
          ...rig.deps,
          runClaim: replacement,
          delivery,
          wakeIfRunnable: wake,
        });

        await wake(rig.threadId);
        await processDetachedWork.drain();

        expect(await delivery.selectPending(rig.threadId)).toEqual([]);

        expect(rig.gateway.requests).toHaveLength(1);
        const request = JSON.stringify(rig.gateway.requests[0]?.messages);
        expect(request).toContain("M1 asks");
        expect(request).toContain("M2 follows");
        expect(await threadMode(rig)).toBe("draft");
      });

      it("cancels a queued switch with a switch back and never cancels a newer one on replay", async () => {
        const rig = await manualFixture();
        const first = crypto.randomUUID();
        const back = crypto.randomUUID();
        const newer = crypto.randomUUID();
        // The journal is what other tabs and replays see: a settled request
        // publishes only the final queue, never a state with both switches.
        const appended = vi.spyOn(rig.eventWriter, "appendEvent");
        const publishedQueues = () =>
          appended.mock.calls.flatMap(([, event]) =>
            event.type === "inbox.changed"
              ? [(event as { pending: ThreadPendingInbox }).pending.items.map((item) => item.id)]
              : [],
          );
        // A run lease stands in for a running reply, so the route leaves the switch queued.
        const reply = await rig.runClaim.startExecution(
          rig.threadId,
          "running-reply",
          async () => {},
        );
        if (!reply) throw new Error("Expected the reply's run claim");
        try {
          expect((await switchMode(rig, "draft", first)).response).toMatchObject({
            pending: { id: first },
            turnId: null,
          });
          appended.mockClear();
          expect(await switchMode(rig, "direct", back)).toEqual({
            created: true,
            response: { id: back, pending: null, turnId: null },
          });
          expect(publishedQueues()).toEqual([[]]);
          expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);

          expect((await switchMode(rig, "draft", newer)).response.pending).toMatchObject({
            id: newer,
          });
          appended.mockClear();
          // Same mode as the queued switch: written settled, the queued one stays.
          expect((await switchMode(rig, "draft")).response).toMatchObject({
            pending: null,
            turnId: null,
          });
          expect(publishedQueues()).toEqual([[newer]]);
          // A retried cancel answers its own settled row.
          expect(await switchMode(rig, "direct", back)).toEqual({
            created: false,
            response: { id: back, pending: null, turnId: null },
          });
          await expect(switchMode(rig, "draft", back)).rejects.toMatchObject({
            statusCode: 409,
            message: "control_id_conflict",
          });
          expect((await rig.delivery.selectPending(rig.threadId)).map((row) => row.id)).toEqual([
            newer,
          ]);
        } finally {
          await rig.runClaim.release(reply);
        }

        await rig.delivery.applyDueSwitches(rig.threadId);
        const turns = await switchTurns(rig);
        expect(
          turns.map((turn) => (turn.metadata as { controlMessageId: string }).controlMessageId),
        ).toEqual([newer]);
        expect(await threadMode(rig)).toBe("draft");
        expect(await rig.delivery.withdrawControl(rig.threadId, first)).toEqual({
          outcome: "withdrawn",
        });
        // Already in draft mode: a new draft request changes nothing.
        expect((await switchMode(rig, "draft")).response).toMatchObject({
          pending: null,
          turnId: null,
        });
        expect(await switchTurns(rig)).toHaveLength(1);
      });

      it("keeps Retry available after a switch and chains the retry after it", async () => {
        const gateway = scriptedGateway({ usage: lowUsage });
        let fail = true;
        const stream = gateway.stream.bind(gateway);
        gateway.stream = async function* (request) {
          if (!fail) {
            yield* stream(request);
            return;
          }
          gateway.requests.push(request);
          yield {
            type: "error" as const,
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
          body: { kind: "text", text: "Answer after the switch." },
          idempotencyKey: "retry-after-switch",
        });
        expect((await drainControls(rig)).status).toBe("error");
        await processDetachedWork.drain();
        const failed = await rig.repos.turns.getLatestByThread(rig.threadId);
        if (!failed) throw new Error("Failed reply was not persisted");
        const applied = await switchMode(rig, "draft");
        fail = false;

        const replyTurnId = crypto.randomUUID();
        const started = await rig.orchestrator.retryReply({
          threadId: rig.threadId,
          failedTurnId: failed.id as never,
          replyTurnId: replyTurnId as never,
        });
        await processDetachedWork.drain();

        expect(started).toMatchObject({
          created: true,
          turn: { prevTurnId: applied.response.turnId },
        });
        // The switch turn between them does not hide the failed reply's user turn.
        expect((await identity(replyTurnId)).reservedForUserTurnIds).toEqual([failed.prevTurnId]);
        expect(await rig.repos.turns.findById(replyTurnId as never)).toMatchObject({
          role: "assistant",
          status: "complete",
          prevTurnId: applied.response.turnId,
        });
        expect(JSON.stringify(gateway.requests.at(-1)?.messages)).toContain(
          "The writer switched this chat to draft mode.",
        );
      });
    });

    describe("run identity", () => {
      function gate() {
        let open!: () => void;
        const promise = new Promise<void>((resolve) => {
          open = resolve;
        });
        return { promise, open };
      }

      async function journalOrder(threadId: string) {
        const rows = await db
          .select({
            seq: schema.eventJournal.seq,
            eventType: schema.eventJournal.eventType,
            payload: schema.eventJournal.payload,
          })
          .from(schema.eventJournal)
          .where(eq(schema.eventJournal.threadId, threadId as never))
          .orderBy(schema.eventJournal.seq);
        return rows.map((row) => ({
          seq: row.seq,
          type: row.eventType,
          payload: row.payload as Record<string, unknown> & { turn?: { id: string } },
        }));
      }

      async function leaseRow(threadId: string) {
        const [row] = await db
          .select()
          .from(schema.threadRunLeases)
          .where(eq(schema.threadRunLeases.threadId, threadId as never));
        return row;
      }

      it("ends an execution whose start-time compaction is cancelled and leaves its message for the next", async () => {
        const summaryStarted = gate();
        const summaryReleased = gate();
        const summarizer = scriptedSummarizer(async () => {
          summaryStarted.open();
          await summaryReleased.promise;
          return {
            kind: "complete",
            text: "Earlier context.",
            model: "summary-model",
            modelResponses: [],
          };
        });
        const rig = await fixture({ summarizer, gateway: scriptedGateway({ usage: lowUsage }) });
        // An empty lease is never an observable execution.
        const empty = await rig.runClaim.startExecution(rig.threadId, crypto.randomUUID(), () =>
          rig.delivery.settleStaleExecution(rig.threadId),
        );
        if (!empty) throw new Error("Expected an empty lease");
        expect(await rig.runClaim.readOpenExecutionId(rig.threadId)).toBeNull();
        await rig.delivery.releaseExecution(empty);
        expect(await endsOf(empty.executionId)).toBe(0);

        const run = await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "M1 asks" });
        const c = await rig.repos.turns.findById(run.executionTurnId);
        expect(c).toMatchObject({ role: "compaction", status: "pending" });
        const e1 = await identity(c?.id);
        expect(e1.reservedForUserTurnIds).toEqual([run.userTurnId]);
        expect(e1.executionId).toBe(run.executionId);
        expect(await rig.runClaim.readOpenExecutionId(rig.threadId)).toBe(e1.executionId);
        rig.setThreshold(100000);

        const done = run.execute();
        await summaryStarted.promise;
        expect(await rig.orchestrator.cancel(rig.threadId, run.executionTurnId)).toBe("cancelled");
        summaryReleased.open();
        expect(await done).toMatchObject({ status: "cancelled" });
        await processDetachedWork.drain();
        if ((await rig.delivery.selectPending(rig.threadId)).length > 0) {
          await rig.orchestrator.startDrain(rig.threadId);
          await processDetachedWork.drain();
        }

        // C's cancel ended E1 without delivering M1; the next execution did.
        expect(await rig.repos.turns.findById(run.executionTurnId)).toMatchObject({
          status: "cancelled",
        });
        expect(await endsOf(e1.executionId)).toBe(1);
        const turns = await settled(rig);
        const reply = turns.find(
          (turn) => turn.role === "assistant" && turn.position > (c?.position ?? 0),
        );
        const e2 = await identity(reply?.id);
        expect(e2.executionId).not.toBe(e1.executionId);
        expect(e2.reservedForUserTurnIds).toEqual([run.userTurnId]);
        expect(await deliveredBy(run.userTurnId)).toBe(reply?.id);
        expect(await endsOf(e2.executionId)).toBe(1);
        expect(await rig.runClaim.readOpenExecutionId(rig.threadId)).toBeNull();

        // Each end is journaled after its execution's last terminal turn, and
        // E1's before E2 reserved anything.
        const order = await journalOrder(rig.threadId);
        const at = (match: (entry: (typeof order)[number]) => boolean) => order.findIndex(match);
        const cCancelled = at(
          (entry) => entry.type === "turn.cancelled" && entry.payload.turn?.id === c?.id,
        );
        const e1Ended = at(
          (entry) =>
            entry.type === "execution.ended" && entry.payload.executionId === e1.executionId,
        );
        const replyCreated = at(
          (entry) => entry.type === "turn.created" && entry.payload.turn?.id === reply?.id,
        );
        expect(cCancelled).toBeGreaterThanOrEqual(0);
        expect(e1Ended).toBeGreaterThan(cCancelled);
        expect(replyCreated).toBeGreaterThan(e1Ended);
      });

      it("answers a Retry replay from its execution, before and after it reserves, and copies its messages", async () => {
        const gateway = scriptedGateway({ usage: lowUsage });
        const stream = gateway.stream.bind(gateway);
        let calls = 0;
        gateway.stream = async function* (request) {
          calls += 1;
          if (calls <= 2) {
            gateway.requests.push(request);
            yield {
              type: "error",
              code: "provider_error",
              message: "provider unavailable",
              retryable: false,
            };
            return;
          }
          yield* stream(request);
        };
        const summaryReleased = gate();
        let summaries = 0;
        const summarizer = scriptedSummarizer(async () => {
          summaries += 1;
          await summaryReleased.promise;
          return {
            kind: "complete",
            text: "Earlier context.",
            model: "summary-model",
            modelResponses: [],
          };
        });
        const rig = await fixture({ gateway, summarizer });
        rig.setThreshold(100000);
        const m1 = await rig.delivery.enqueue({
          threadId: rig.threadId,
          intent: "message",
          provenance: { kind: "writer", actorId: rig.ids.user },
          body: { kind: "text", text: "Answer M1." },
          idempotencyKey: "identity-retry-m1",
        });
        await drainControls(rig);
        await processDetachedWork.drain();
        const f1 = await rig.repos.turns.getLatestByThread(rig.threadId);
        expect(f1).toMatchObject({ role: "assistant", status: "error" });
        expect((await identity(f1?.id)).reservedForUserTurnIds).toEqual([m1.id]);

        // A Retry of the failed reply fails too; its own Retry copies [M1] again.
        const r1 = await rig.orchestrator.retryReply({
          threadId: rig.threadId,
          failedTurnId: f1?.id as never,
          replyTurnId: crypto.randomUUID() as never,
        });
        await processDetachedWork.drain();
        const failedRetry = await rig.repos.turns.findById(r1.turn?.id as never);
        expect(failedRetry).toMatchObject({ status: "error", metadata: { retryOf: f1?.id } });
        expect((await identity(failedRetry?.id)).reservedForUserTurnIds).toEqual([m1.id]);

        // The next Retry compacts at start. Hold its claim before it reserves.
        rig.setThreshold(2500);
        const claimed = gate();
        const proceed = gate();
        const startExecution = rig.runClaim.startExecution.bind(rig.runClaim);
        rig.runClaim.startExecution = async (threadId, executionId, settle) =>
          startExecution(threadId, executionId, async () => {
            await settle();
            claimed.open();
            await proceed.promise;
          });
        const replyTurnId = crypto.randomUUID();
        const retry = {
          threadId: rig.threadId,
          failedTurnId: failedRetry?.id as never,
          replyTurnId: replyTurnId as never,
        };
        const first = rig.orchestrator.retryReply(retry);
        await claimed.promise;
        // Nothing is reserved yet: this replay can't know whose the claim is.
        await expect(rig.orchestrator.retryReply(retry)).rejects.toMatchObject({
          code: "retry_pending",
        });
        // Another tab's Retry of the same reply is refused once one is under way.
        proceed.open();
        const accepted = await first;
        expect(accepted).toMatchObject({ created: true, executionId: expect.any(String) });
        rig.runClaim.startExecution = startExecution;

        // C is reserved and summarizing; the reply is not: the replay finds C.
        const c = await rig.repos.turns.findRetryReservation(rig.threadId, replyTurnId as never);
        expect(c).toMatchObject({
          role: "compaction",
          executionId: accepted.executionId,
          metadata: { retryOf: failedRetry?.id, retryReplyId: replyTurnId },
        });
        expect((await identity(c?.id)).reservedForUserTurnIds).toEqual([m1.id]);
        expect(await rig.orchestrator.retryReply(retry)).toEqual({
          created: false,
          turn: null,
          executionId: accepted.executionId,
        });
        await expect(
          rig.orchestrator.retryReply({ ...retry, replyTurnId: crypto.randomUUID() as never }),
        ).rejects.toMatchObject({ code: "reply_retry_unavailable" });

        summaryReleased.open();
        await processDetachedWork.drain();
        expect(summaries).toBe(1);
        const reply = await rig.repos.turns.findById(replyTurnId as never);
        expect(reply).toMatchObject({ role: "assistant", status: "complete" });
        expect(await identity(replyTurnId)).toEqual({
          executionId: accepted.executionId,
          reservedForUserTurnIds: [m1.id],
        });
        expect(await rig.orchestrator.retryReply(retry)).toMatchObject({
          created: false,
          turn: { id: replyTurnId },
          executionId: accepted.executionId,
        });
        expect(await endsOf(accepted.executionId)).toBe(1);
        // M1 was delivered once, by the first reply that failed it.
        expect(await deliveredBy(m1.id)).toBe(f1?.id);
      });

      async function failedReply(rig: Awaited<ReturnType<typeof fixture>>, key: string) {
        await rig.delivery.enqueue({
          threadId: rig.threadId,
          intent: "message",
          provenance: { kind: "writer", actorId: rig.ids.user },
          body: { kind: "text", text: "Answer M1." },
          idempotencyKey: key,
        });
        await drainControls(rig);
        await processDetachedWork.drain();
        const failed = await rig.repos.turns.getLatestByThread(rig.threadId);
        expect(failed).toMatchObject({ role: "assistant", status: "error" });
        return failed?.id as never;
      }

      it.each([
        { first: "assistant", threshold: 100000 },
        { first: "compaction", threshold: 2500 },
      ])("runs a Retry whose answer read fails after it reserved its $first", async ({
        first,
        threshold,
      }) => {
        const gateway = scriptedGateway({ usage: lowUsage, errorAtCall: 1 });
        const rig = await manualFixture({ gateway });
        const failedTurnId = await failedReply(rig, `retry-describe-${first}`);
        rig.setThreshold(threshold);
        const replyTurnId = crypto.randomUUID() as never;
        // The replay lookup reads the reply first; the next read describes the answer.
        const findById = rig.repos.turns.findById.bind(rig.repos.turns);
        let replyReads = 0;
        rig.repos.turns.findById = async (id) => {
          if (id === replyTurnId && ++replyReads === 2) throw new Error("turn read unavailable");
          return findById(id);
        };
        const answer = await rig.orchestrator.retryReply({
          threadId: rig.threadId,
          failedTurnId,
          replyTurnId,
        });
        rig.repos.turns.findById = findById;
        expect(answer.executionId).toEqual(expect.any(String));
        const reservation = await rig.repos.turns.findRetryReservation(rig.threadId, replyTurnId);
        expect(reservation).toMatchObject({ role: first, executionId: answer.executionId });

        await processDetachedWork.drain();
        expect(await rig.repos.turns.findById(replyTurnId)).toMatchObject({
          status: "complete",
          executionId: answer.executionId,
        });
        expect(rig.orchestrator.isThreadRunning(rig.threadId)).toBe(false);
        expect(await endsOf(answer.executionId)).toBe(1);
        expect(await leaseRow(rig.threadId)).toBeUndefined();
      });

      it.each([
        { shuttingDown: false, otherRequest: "reply_retry_unavailable" },
        // Shutdown stops new work; it never denies work already accepted.
        { shuttingDown: true, otherRequest: "runtime_shutting_down" },
      ])("answers a same-id replay that read the leaf after its own Retry reserved (shutdown: $shuttingDown)", async ({
        shuttingDown,
        otherRequest,
      }) => {
        const gateway = scriptedGateway({ usage: lowUsage, errorAtCall: 1 });
        const rig = await manualFixture({ gateway });
        const failedTurnId = await failedReply(rig, "retry-replay-race");
        const retry = {
          threadId: rig.threadId,
          failedTurnId,
          replyTurnId: crypto.randomUUID() as never,
        };
        // The winner holds the claim with no lease row and nothing reserved.
        const claimed = gate();
        const proceed = gate();
        const startExecution = rig.runClaim.startExecution.bind(rig.runClaim);
        rig.runClaim.startExecution = async (threadId, executionId, settle) =>
          startExecution(threadId, executionId, async () => {
            await settle();
            claimed.open();
            await proceed.promise;
          });
        const winner = rig.orchestrator.retryReply(retry);
        await claimed.promise;
        await expect(rig.orchestrator.retryReply(retry)).rejects.toMatchObject({
          code: "retry_pending",
        });

        // The repeated replay reads status (asleep) before the winner reserves,
        // and the leaf only after the winner's reply finished.
        const latestRead = gate();
        const latestReleased = gate();
        const getLatestByThread = rig.repos.turns.getLatestByThread.bind(rig.repos.turns);
        rig.repos.turns.getLatestByThread = async (threadId) => {
          rig.repos.turns.getLatestByThread = getLatestByThread;
          latestRead.open();
          await latestReleased.promise;
          return getLatestByThread(threadId);
        };
        const statusRead = gate();
        const read = rig.runClaim.read.bind(rig.runClaim);
        rig.runClaim.read = async (threadId) => {
          rig.runClaim.read = read;
          const state = await read(threadId);
          statusRead.open();
          return state;
        };
        const replay = rig.orchestrator.retryReply(retry);
        await Promise.all([latestRead.promise, statusRead.promise]);
        rig.runClaim.startExecution = startExecution;
        proceed.open();
        const accepted = await winner;
        await processDetachedWork.drain();
        expect(rig.orchestrator.isThreadRunning(rig.threadId)).toBe(false);
        if (shuttingDown) rig.deps.shutdown.started = true;
        latestReleased.open();

        expect(await replay).toMatchObject({
          created: false,
          turn: { id: retry.replyTurnId },
          executionId: accepted.executionId,
        });
        // Another tab's request id is still refused.
        await expect(
          rig.orchestrator.retryReply({ ...retry, replyTurnId: crypto.randomUUID() as never }),
        ).rejects.toMatchObject({ code: otherRequest });
      });

      it("abandons an execution whose terminal write failed, and the next claim holder settles it first", async () => {
        const gateway = scriptedGateway({ usage: lowUsage, pauseAt: [1] });
        const rig = await manualFixture({ gateway });
        const run = await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "M1 asks" });
        const e1 = await identity(run.executionTurnId);
        const done = run.execute();
        await gateway.untilGatewayBoundary(1);
        const close = rig.delivery.close;
        rig.delivery.close = async () => {
          throw new Error("terminal write unavailable");
        };
        gateway.release(1);
        expect(await done).toMatchObject({ status: "failed" });
        rig.delivery.close = close;

        // Abandoned: unlocked and asleep, but not ended, and still open.
        const abandoned = await leaseRow(rig.threadId);
        expect(abandoned?.executionId).toBe(e1.executionId);
        expect(abandoned?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
        expect((await rig.runClaim.read(rig.threadId)).kind).toBe("asleep");
        expect(await rig.repos.turns.findById(run.executionTurnId)).toMatchObject({
          status: "streaming",
        });
        expect(await endsOf(e1.executionId)).toBe(0);
        expect(await rig.runClaim.readOpenExecutionId(rig.threadId)).toBe(e1.executionId);

        // The next holder repairs, ends E1 and deletes its row before its own lease exists.
        const startExecution = rig.runClaim.startExecution.bind(rig.runClaim);
        let rowAtInsert: Awaited<ReturnType<typeof leaseRow>> | "unseen" = "unseen";
        rig.runClaim.startExecution = async (threadId, executionId, settle) =>
          startExecution(threadId, executionId, async () => {
            await settle();
            rowAtInsert = await leaseRow(threadId);
          });
        await rig.send(rig.threadId, "M2 follows");
        await rig.orchestrator.startDrain(rig.threadId);
        await processDetachedWork.drain();
        rig.runClaim.startExecution = startExecution;
        expect(rowAtInsert).toBeUndefined();

        expect(await rig.repos.turns.findById(run.executionTurnId)).toMatchObject({
          status: "error",
          metadata: { reason: "orphaned" },
        });
        expect(await deliveredBy(run.userTurnId)).toBe(run.executionTurnId);
        expect(await endsOf(e1.executionId)).toBe(1);
        const order = await journalOrder(rig.threadId);
        const orphanError = order.findIndex(
          (entry) => entry.type === "turn.error" && entry.payload.turn?.id === run.executionTurnId,
        );
        const ended = order.findIndex(
          (entry) =>
            entry.type === "execution.ended" && entry.payload.executionId === e1.executionId,
        );
        const next = order.findIndex(
          (entry, index) =>
            index > ended &&
            entry.type === "turn.created" &&
            (entry.payload.turn as unknown as Turn | undefined)?.role === "assistant",
        );
        expect(orphanError).toBeGreaterThanOrEqual(0);
        expect(ended).toBeGreaterThan(orphanError);
        expect(next).toBeGreaterThan(ended);
        const turns = await settled(rig);
        expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
        expect((await identity(turns.at(-1)?.id)).executionId).not.toBe(e1.executionId);
      });

      it("settles an expired lease with no unsettled turn from the repair lane", async () => {
        const rig = await manualFixture();
        // A crash after repair committed the turn's error but before the end:
        // the turn carries the execution, the expired row remains.
        const executionId = crypto.randomUUID();
        const leaf = await rig.repos.turns.getLatestByThread(rig.threadId);
        const repaired = await rig.repos.turns.create({
          threadId: rig.threadId,
          prevTurnId: leaf?.id as never,
          role: "assistant",
          origin: "assistant",
          status: "error",
          executionId,
          reservedForUserTurnIds: [],
        });
        const stale = new Date(Date.now() - 60_000);
        await db.insert(schema.threadRunLeases).values({
          threadId: rig.threadId,
          executionId,
          turnId: repaired.id,
          holderId: "dead-worker",
          acquiredAt: stale,
          renewedAt: stale,
          expiresAt: stale,
        });
        expect(await rig.runClaim.readOpenExecutionId(rig.threadId)).toBe(executionId);
        const legacy = await rig.repos.threads.create({
          aiWriteMode: "direct",
          id: crypto.randomUUID(),
          userId: rig.ids.user,
          projectId: rig.ids.project,
        });
        await db.insert(schema.threadRunLeases).values({
          threadId: legacy.id,
          executionId: "run-before-identity",
          holderId: "dead-worker",
          acquiredAt: stale,
          renewedAt: stale,
          expiresAt: stale,
        });
        expect(await rig.runClaim.readOpenExecutionId(legacy.id as never)).toBeNull();

        const repair = createTestOrphanRepair(db, {
          repos: rig.repos,
          inbox: rig.delivery,
          eventWriter: rig.eventWriter,
          authority: rig.runClaim,
          threadLock: createDrizzleThreadLock(db),
          publisher: { publish: async () => "already" as const },
          eventSink: rig.deps.eventSink,
        });
        await repair.sweep(10);

        expect(await leaseRow(rig.threadId)).toBeUndefined();
        expect(await leaseRow(legacy.id)).toBeUndefined();
        expect(await endsOf(executionId)).toBe(1);
        expect(await endsOf("run-before-identity")).toBe(0);
        expect(await rig.runClaim.readOpenExecutionId(rig.threadId)).toBeNull();
      });
    });
  });
