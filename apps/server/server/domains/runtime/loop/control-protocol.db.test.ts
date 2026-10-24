/**
 * Control queue ordering, start consumption, and withdrawal against PostgreSQL.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - current control protocol persistence protocol (kb/decisions/engineering/runtime/runtime-delivery-and-run-claim.md)
 */

import type { Turn } from "@meridian/contracts/threads";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { journalEventsByThread } from "../../../test-support/journal-events.js";
import { releaseLeaseUnderLock } from "../../../test-support/release-lease.js";
import {
  createOrchestratorEventProjector,
  eventSeqForJournalEvent,
  loadThreadConversationContext,
  TurnStartConflictError,
} from "../../threads/index.js";
import { turnGraph } from "../../threads/ports/turn-graph.js";
import { createDrizzleRunClaim } from "../adapters/drizzle-run-claim.js";
import { createCompactionFixture } from "./__tests__/compaction-db-fixture.js";
import { scriptedSummarizer } from "./__tests__/scripted-summarizer.js";
import {
  createTestDrizzleDelivery,
  createTestOrphanRepair,
} from "./__tests__/test-drizzle-delivery.js";
import { scriptedGateway } from "./__tests__/test-gateway.js";
import { projectActiveHistoryWithBakes } from "./compaction/project.js";
import { createOrchestrator } from "./orchestrator.js";
import { createRunStarter } from "./run-starter.js";
import { createWakeIfRunnable } from "./wake-if-runnable.js";

const url = process.env.DATABASE_URL;
if (!url || !["1", "true"].includes(process.env.RUN_DB_TESTS ?? ""))
  describe.skip("control protocol", () => {});
else
  describe("control protocol", async () => {
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
    afterAll(() => audited.close());
    // Publication pins: no input write without a record, and the last record equals the rows.
    afterEach(() => assertPublicationHooks(db));

    const fixture = createCompactionFixture(db);
    const lowUsage = { inputTokens: 100, outputTokens: 10 };

    async function manualFixture(options: Parameters<typeof fixture>[0] = {}) {
      const rig = await fixture({ gateway: scriptedGateway({ usage: lowUsage }), ...options });
      rig.setThreshold(100000);
      return rig;
    }

    /** Every appended journal row with its journal seq and projected socket frames. */
    async function appendedFrames(appended: {
      mock: { calls: unknown[][]; results: { value: unknown }[] };
    }) {
      const projector = createOrchestratorEventProjector();
      const rows: { journalSeq: bigint; frames: { name?: string }[] }[] = [];
      for (const [callIndex, [, events]] of appended.mock.calls.entries()) {
        const batch = events as unknown[];
        const lastSeq = (await appended.mock.results[callIndex]?.value) as bigint;
        const firstSeq = lastSeq - BigInt(batch.length) + 1n;
        for (const [index, event] of batch.entries()) {
          rows.push({
            journalSeq: firstSeq + BigInt(index),
            frames: projector.project(event as never) as { name?: string }[],
          });
        }
      }
      return rows;
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

    /** The turn that delivered a message. */
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
      return row.byTurnId;
    }

    /** Whether an execution that reserved a turn has ended: its lease row is gone. */
    async function ended(executionId: string | null) {
      if (!executionId || !/^[0-9a-f-]{36}$/.test(executionId)) return false;
      const [carried] = await db
        .select({ id: schema.turns.id })
        .from(schema.turns)
        .where(eq(schema.turns.executionId, executionId))
        .limit(1);
      const rows = await db
        .select({ id: schema.threadRunLeases.executionId })
        .from(schema.threadRunLeases)
        .where(eq(schema.threadRunLeases.executionId, executionId));
      return carried !== undefined && rows.length === 0;
    }

    /** Starts a reply; a due switch applies at its run-start boundary. */
    async function drainControls(rig: Awaited<ReturnType<typeof fixture>>) {
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      return run.execute();
    } /** A turn's `forgotten_by_turn_id`, read from the row. */
    async function stampOf(turnId: string) {
      const [row] = await db
        .select({ by: schema.turns.forgottenByTurnId })
        .from(schema.turns)
        .where(eq(schema.turns.id, turnId as never));
      return row?.by ?? null;
    }

    /** One writer message answered by an empty failed reply: the abandoned exchange. */
    async function emptyFailure(rig: Awaited<ReturnType<typeof fixture>>, text: string) {
      const failed = await (
        await rig.orchestrator.prepare({ threadId: rig.threadId, tools: [], userText: text })
      ).execute();
      await processDetachedWork.drain();
      expect(failed.status).toBe("error");
      const reply = await turnGraph(rig.repos.turns).latest(rig.threadId);
      if (reply?.role !== "assistant" || reply.status !== "error")
        throw new Error("Expected an empty failed reply");
      const message = await rig.repos.turns.findById(reply.prevTurnId as never);
      if (!message) throw new Error("Expected the failed reply's message");
      return { reply, message };
    }

    it("forgets an empty failure and its message when /compact follows, before the summary is planned (C1a)", async () => {
      // Risk (FX1 review blocker): the summary holding the abandoned message's words, or the cut resting on a
      // turn the conversation no longer has, so the next run start and the handoff fail to project.
      const summarizer = scriptedSummarizer();
      const rig = await manualFixture({
        gateway: scriptedGateway({ usage: lowUsage, errorAtCall: 1 }),
        summarizer,
      });
      const { reply, message } = await emptyFailure(rig, "FORGET-ME abandoned message");
      await compactControl(rig);
      expect((await drainControls(rig)).status).toBe("complete");
      const turns = await settled(rig);
      const compaction = turns.find((turn) => turn.role === "compaction");
      expect(compaction).toMatchObject({ status: "complete" });
      expect(await stampOf(reply.id)).toBe(compaction?.id);
      expect(await stampOf(message.id)).toBe(compaction?.id);
      expect(JSON.stringify(summarizer.calls)).not.toContain("FORGET-ME");
      // The journal states what the commit forgot, after the reservation that forgot it.
      const forgotten = (await journal()).find(({ eventType }) => eventType === "turns.forgotten");
      expect(forgotten?.payload).toMatchObject({
        turnIds: [reply.id, message.id],
        byTurnId: compaction?.id,
        reason: "forgotten",
      });
      // A later run start and a handoff-shaped projection of the whole conversation both succeed.
      const thread = await rig.repos.threads.findById(rig.threadId);
      if (!thread) throw new Error("Expected the thread");
      const context = await loadThreadConversationContext(rig.repos, thread);
      expect(context.turns.map((turn) => turn.id)).not.toContain(message.id);
      await projectActiveHistoryWithBakes(
        context.turns,
        context.blocks,
        thread.ref,
        rig.repos.promptBakes,
      );
      const next = await (
        await rig.orchestrator.prepare({ threadId: rig.threadId, tools: [], userText: "Go on." })
      ).execute();
      expect(next.status).toBe("complete");
    });

    it("refuses /compact before any completed reply and forgets nothing, so the failure keeps Retry (C1b)", async () => {
      // Risk: a refused command still stamping turns, or the refusal costing the writer their Retry.
      const rig = await manualFixture({
        empty: true,
        gateway: scriptedGateway({ usage: lowUsage, errorAtCall: 1 }),
      });
      const { reply, message } = await emptyFailure(rig, "Nothing completed yet.");
      await expect(
        rig.delivery.enqueueControl({
          threadId: rig.threadId,
          actorId: rig.ids.user,
          id: crypto.randomUUID(),
          control: { kind: "compact" },
        }),
      ).rejects.toMatchObject({ statusCode: 409, message: "compact_requires_completed_reply" });
      expect(await stampOf(reply.id)).toBeNull();
      expect(await stampOf(message.id)).toBeNull();
      await expect(
        rig.orchestrator.retryReply({
          threadId: rig.threadId,
          failedTurnId: reply.id as never,
          replyTurnId: crypto.randomUUID() as never,
        }),
      ).resolves.toMatchObject({ created: true });
      await processDetachedWork.drain();
    });

    it("keeps a message a pre-release summary holds when a failed Retry's chat moves on (C12)", async () => {
      // Risk: forgetting a writer message whose words a complete compaction already summarized without
      // pinning it. The release has no backfill, so the real loader must protect it. The others go.
      const rig = await manualFixture({
        gateway: scriptedGateway({ usage: lowUsage, errorAtCall: 1 }),
      });
      for (const text of ["covered by the summary", "after the cut"]) {
        await rig.delivery.enqueue({
          threadId: rig.threadId,
          intent: "message",
          provenance: { kind: "writer", actorId: rig.ids.user },
          body: { kind: "text", text },
          idempotencyKey: text,
        });
      }
      expect((await drainControls(rig)).status).toBe("error");
      await processDetachedWork.drain();
      const f = await turnGraph(rig.repos.turns).latest(rig.threadId);
      const messages = (await turnGraph(rig.repos.turns).listByThread(rig.threadId)).filter(
        (turn) => turn.role === "user" && turn.origin === "writer",
      );
      const [, first, second] = messages;
      if (!f || !first || !second) throw new Error("Expected two delivered messages and a failure");
      // The pre-release shape: a Retry-led compaction C summarized `first` without pinning it, and the
      // Retry R failed empty.
      const replyId = crypto.randomUUID();
      const compaction = await rig.repos.turns.create({
        threadId: rig.threadId,
        prevTurnId: f.id,
        role: "compaction",
        origin: "system",
        status: "complete",
        compactionModel: "summary-model",
        metadata: {
          trigger: "manual",
          compactedThrough: { turnId: first.id },
          pinnedRequestTurnIds: [],
          retryOf: f.id,
          retryReplyId: replyId,
        },
      });
      const retry = await rig.repos.turns.create({
        id: replyId as never,
        threadId: rig.threadId,
        prevTurnId: compaction.id,
        role: "assistant",
        origin: "assistant",
        status: "error",
        executionId: crypto.randomUUID(),
      });
      await rig.delivery.enqueue({
        threadId: rig.threadId,
        intent: "message",
        provenance: { kind: "writer", actorId: rig.ids.user },
        body: { kind: "text", text: "moving on" },
        idempotencyKey: "moving-on",
      });
      await rig.delivery.materializeIdle(rig.threadId);
      expect(await stampOf(first.id)).toBeNull();
      expect(await stampOf(second.id)).not.toBeNull();
      expect(await stampOf(retry.id)).not.toBeNull();
      expect(await stampOf(f.id)).not.toBeNull();
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
      const graph = turnGraph(rig.repos.turns);
      const findTurn = graph.findById.bind(graph);
      graph.findById = async (id) => (id === answer.id ? null : findTurn(id));

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
      const failed = await turnGraph(rig.repos.turns).latest(rig.threadId);
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
      expect((await turnGraph(rig.repos.turns).latest(rig.threadId))?.id).toBe(replyTurnId);
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
    it("acknowledges a crashed reply's adopted messages and leaves queued work for Retry", async () => {
      const gateway = scriptedGateway({ usage: lowUsage });
      const rig = await manualFixture({ gateway });
      const previous = await turnGraph(rig.repos.turns).latest(rig.threadId);
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

      // The test starts each run itself; a release wake would take the claim first.
      const recovery = createOrchestrator({
        ...rig.deps,
        runClaim: replacement,
        delivery,
        wakeIfRunnable: async () => {},
      });
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
      const appended = vi.spyOn(rig.eventWriter, "appendEvents");
      const answer = await rig.delivery.withdrawControl(rig.threadId, withdrawn.id);
      expect(answer).toMatchObject({
        outcome: "withdrawn",
        runState: { mode: (await rig.repos.threads.findById(rig.threadId))?.aiWriteMode },
      });
      // The answer's clock reaches the withdrawal's own run-state frame.
      const [withdrawal] = (await appendedFrames(appended)).filter((row) =>
        row.frames.some((frame) => frame.name === "meridian.run_state"),
      );
      expect(answer.runState.version).toBe(
        eventSeqForJournalEvent(withdrawal?.journalSeq as bigint, 0).toString(),
      );
      expect(await rig.delivery.withdrawControl(rig.threadId, withdrawn.id)).toMatchObject({
        outcome: "withdrawn",
      });
      await drainControls(rig);
      expect(JSON.stringify(rig.gateway.requests.at(-1)?.messages.at(-1))).toContain(
        "B behind withdrawn compact",
      );

      const started = await compactControl(rig);
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      expect(await rig.delivery.withdrawControl(rig.threadId, started.id)).toMatchObject({
        outcome: "already_started",
      });
      await run.execute();
      await settled(rig);
      expect(await rig.delivery.withdrawControl(rig.threadId, started.id)).toMatchObject({
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
      expect(retry).toMatchObject({
        created: false,
        response: { id: input.id, runState: { items: [] } },
      });
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
      await releaseLeaseUnderLock(db, rig.runClaim, {
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
      // The test starts each run itself; a release wake would take the claim first.
      const recovery = createOrchestrator({
        ...rig.deps,
        runClaim: replacement,
        delivery,
        wakeIfRunnable: async () => {},
      });

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

      it("serves the pending mode on the thread and the project list until switch-back or Stop", async () => {
        const rig = await manualFixture();
        const served = async () => {
          const listed = (await rig.repos.threads.listByProject(rig.ids.project as never)).find(
            (item) => item.id === rig.threadId,
          );
          const got = await rig.repos.threads.findById(rig.threadId);
          return [listed?.aiWriteMode, listed?.effectiveAiWriteMode, got?.effectiveAiWriteMode];
        };
        expect(await served()).toEqual(["direct", "direct", "direct"]);
        await switchMode(rig, "draft");
        expect(await served()).toEqual(["direct", "draft", "draft"]);
        await switchMode(rig, "direct");
        expect(await served()).toEqual(["direct", "direct", "direct"]);
        const queued = await switchMode(rig, "draft");
        await rig.delivery.withdrawControl(rig.threadId, queued.response.id);
        expect(await served()).toEqual(["direct", "direct", "direct"]);
      });

      it("does not apply a queued switch after the chat is deleted", async () => {
        const rig = await manualFixture();
        const lease = await rig.runClaim.startExecution(
          rig.threadId as never,
          crypto.randomUUID() as never,
          async () => {},
        );
        if (!lease) throw new Error("Expected a run claim");
        const queued = await switchMode(rig, "draft");
        expect(queued.response.turnId).toBeNull();
        await rig.repos.threads.setTrashState(rig.threadId, "deleted");
        await releaseLeaseUnderLock(db, rig.runClaim, lease);
        await processDetachedWork.drain();
        await expect(rig.orchestrator.startDrain(rig.threadId)).rejects.toThrow("Thread not found");
        expect(await switchTurns(rig)).toEqual([]);
        expect((await rig.repos.threads.lockByIdIncludingDeleted(rig.threadId))?.aiWriteMode).toBe(
          "direct",
        );
        expect((await rig.runClaim.read(rig.threadId)).kind).toBe("asleep");
      });

      it("ends a reserved execution cleanly when its chat is deleted before execution", async () => {
        const rig = await manualFixture();
        const run = await rig.orchestrator.prepare({
          threadId: rig.threadId,
          userText: "reserved",
        });
        const reserved = (await rig.repos.turns.listByThread(rig.threadId)).at(-1);
        expect(reserved?.executionId).toBeTruthy();
        await rig.repos.threads.setTrashState(rig.threadId, "deleted");
        await run.execute();
        await processDetachedWork.drain();
        expect((await rig.repos.turns.findById(reserved?.id as never))?.status).toBe("error");
        expect(await ended(reserved?.executionId ?? null)).toBe(true);
        expect((await rig.runClaim.read(rig.threadId)).kind).toBe("asleep");
      });

      it("keeps an idle switch pending until a reply starts, then applies it as one complete switch turn", async () => {
        const gateway = scriptedGateway({ usage: lowUsage });
        const rig = await manualFixture({ gateway });
        const queued = await switchMode(rig, "draft");

        // Nothing runs, so nothing applies: no turn, the chat keeps its mode, and
        // the answer carries the pending switch for the toolbar.
        expect(queued).toMatchObject({
          created: true,
          response: {
            turnId: null,
            runState: {
              items: [expect.objectContaining({ id: queued.response.id })],
              mode: "direct",
            },
          },
        });
        expect(await switchTurns(rig)).toEqual([]);
        expect(await threadMode(rig)).toBe("direct");

        const appended = vi.spyOn(rig.eventWriter, "appendEvents");
        // Writer admission persists the message first; the switch applies behind it, before the reply.
        const admitted = await rig.send(rig.threadId, "Write it.");
        await drainControls(rig);
        const turns = await settled(rig);
        const [turn] = await switchTurns(rig);
        expect(turn).toMatchObject({
          role: "system",
          status: "complete",
          writeMode: "draft",
          prevTurnId: admitted.userTurnId,
          metadata: {
            kind: "write_mode_switch",
            mode: "draft",
            controlMessageId: queued.response.id,
          },
        });
        expect((await rig.repos.blocks.listByTurn(turn?.id as never))[0]?.textContent).toContain(
          "The writer switched this chat to draft mode.",
        );
        const tail = turns.slice(turns.findIndex((entry) => entry.id === admitted.userTurnId));
        expect(tail.map((entry) => entry.role)).toEqual(["user", "system", "assistant"]);
        expect(tail[2]).toMatchObject({ writeMode: "draft" });
        expect(await threadMode(rig)).toBe("draft");
        expect(JSON.stringify(gateway.requests.at(-1)?.messages)).toContain(
          "The writer switched this chat to draft mode.",
        );
        // The apply is a frame of its own, ahead of the run-state frame that empties the queue.
        const frames = (await appendedFrames(appended)).flatMap((row) => row.frames);
        const names = frames.map((frame) => frame.name);
        const switched = names.indexOf("meridian.write_mode.switched");
        expect(switched).toBeGreaterThan(-1);
        expect(names.lastIndexOf("meridian.run_state")).toBeGreaterThan(switched);
        expect(frames[switched]).toMatchObject({
          value: {
            threadId: rig.threadId,
            mode: "draft",
            controlId: queued.response.id,
            turnId: turn?.id,
          },
        });
        expect(await rig.delivery.withdrawControl(rig.threadId, queued.response.id)).toMatchObject({
          outcome: "already_started",
        });

        // The apply's own transaction publishes the record with the new mode, after the divider's
        // turn.created.
        const journal = await journalEventsByThread(db, rig.threadId);
        const divider = journal.find(
          (row) =>
            row.eventType === "turn.created" &&
            (row.payload as { turn: Turn }).turn.id === turn?.id,
        );
        const record = journal.find(
          (row) => row.eventType === "run_state.changed" && row.seq > (divider?.seq as bigint),
        );
        expect(record).toBeDefined();
        expect(record?.createdAt).toEqual(divider?.createdAt);
        expect(record?.payload).toMatchObject({ runState: { mode: "draft" } });
        expect(
          (record?.payload as { runState: { items: { id: string }[] } }).runState.items.map(
            (item) => item.id,
          ),
        ).not.toContain(queued.response.id);
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
          runState: {
            items: expect.arrayContaining([
              expect.objectContaining({
                deliveryState: "waiting",
                control: { kind: "write_mode", mode: "draft" },
              }),
            ]),
          },
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
        expect(admitted).toMatchObject({ userTurnId: tail[2]?.id });
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
        expect(await ended(a.executionId)).toBe(true);
        expect(await ended(b.executionId)).toBe(true);
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
        // M2 was steered into A; B, in A's execution, is reserved for M2 and delivers it.
        expect(admitted).toMatchObject({ userTurnId: tail[2]?.id });
        expect(tail[2]?.metadata).toMatchObject({ delivery: "steer" });
        const a = await identity(tail[1]?.id);
        const b = await identity(tail[3]?.id);
        expect(a.executionId).toEqual(expect.any(String));
        expect(b.executionId).toBe(a.executionId);
        expect(a.reservedForUserTurnIds).toEqual([tail[0]?.id]);
        expect(b.reservedForUserTurnIds).toEqual([tail[2]?.id]);
        expect(await deliveredBy(tail[0]?.id)).toBe(tail[1]?.id);
        expect(await deliveredBy(tail[2]?.id)).toBe(tail[3]?.id);
        expect(await ended(a.executionId)).toBe(true);
      });

      it("names no reply for a message admitted after the live reply ended and its switch pending", async () => {
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
          expect(await threadMode(rig)).toBe("direct");
          return lock(...args);
        });

        const admitted = await rig.send(rig.threadId, "M2 after A ended");
        expect(
          (await rig.repos.turns.findById(admitted.userTurnId as never))?.metadata,
        ).not.toMatchObject({ delivery: "steer" });

        await drainControls(rig);
        const turns = await settled(rig);
        // The message's turn is persisted at admission; the pending switch applies after it, before the reply.
        const switchTurn = turns.find((turn) => turn.prevTurnId === admitted.userTurnId);
        expect(switchTurn?.metadata).toMatchObject({ kind: "write_mode_switch" });
        const answer = turns.find((turn) => turn.prevTurnId === switchTurn?.id);
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
        await releaseLeaseUnderLock(db, rig.runClaim, {
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
            { startDrain: (id) => recovery.startDrain(id) },
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
        const appended = vi.spyOn(rig.eventWriter, "appendEvents");
        const publishedQueues = () =>
          appended.mock.calls.flatMap(([, events]) =>
            events.flatMap((event) =>
              event.type === "run_state.changed"
                ? [event.runState.items.map((item) => item.id)]
                : [],
            ),
          );
        expect((await switchMode(rig, "draft", first)).response).toMatchObject({
          runState: { items: [expect.objectContaining({ id: first })] },
          turnId: null,
        });
        appended.mockClear();
        expect(await switchMode(rig, "direct", back)).toMatchObject({
          created: true,
          response: { id: back, turnId: null, runState: { items: [], mode: "direct" } },
        });
        expect(publishedQueues()).toEqual([[]]);
        expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);

        expect((await switchMode(rig, "draft", newer)).response.runState.items).toContainEqual(
          expect.objectContaining({ id: newer }),
        );
        appended.mockClear();
        // Same mode as the queued switch: written settled, the queued one stays.
        // The answer names the thread's queued switch, not only its own row.
        expect((await switchMode(rig, "draft")).response).toMatchObject({
          runState: { items: [expect.objectContaining({ id: newer })] },
          turnId: null,
        });
        expect(publishedQueues()).toEqual([[newer]]);
        // A retried cancel answers its own settled row.
        expect(await switchMode(rig, "direct", back)).toMatchObject({
          created: false,
          response: {
            id: back,
            turnId: null,
            runState: { items: [expect.objectContaining({ id: newer })], mode: "direct" },
          },
        });
        await expect(switchMode(rig, "draft", back)).rejects.toMatchObject({
          statusCode: 409,
          message: "control_id_conflict",
        });
        expect((await rig.delivery.selectPending(rig.threadId)).map((row) => row.id)).toEqual([
          newer,
        ]);
        // A message starts the next run, which applies the switch queued ahead of it.
        await rig.delivery.enqueue({
          threadId: rig.threadId,
          intent: "message",
          provenance: { kind: "writer", actorId: rig.ids.user },
          body: { kind: "text", text: "Go." },
          idempotencyKey: "after-newer-switch",
        });
        await drainControls(rig);
        const turns = await switchTurns(rig);
        expect(
          turns.map((turn) => (turn.metadata as { controlMessageId: string }).controlMessageId),
        ).toEqual([newer]);
        expect(await threadMode(rig)).toBe("draft");
        expect(await rig.delivery.withdrawControl(rig.threadId, first)).toMatchObject({
          outcome: "withdrawn",
        });
        // Already in draft mode: a new draft request changes nothing.
        expect((await switchMode(rig, "draft")).response).toMatchObject({
          runState: { items: [] },
          turnId: null,
        });
        expect(await switchTurns(rig)).toHaveLength(1);
      });

      it("blocks a saved message and its queued switch for usage, then answers both once usage returns", async () => {
        const rig = await manualFixture();
        const canStart = vi.spyOn(rig.deps.billingUsage, "canStartTurn").mockResolvedValue(false);
        await switchMode(rig, "draft");
        const message = await rig.delivery.enqueue({
          threadId: rig.threadId,
          intent: "message",
          provenance: { kind: "writer", actorId: rig.ids.user },
          body: { kind: "text", text: "Wait for usage." },
          idempotencyKey: "blocked-with-switch",
        });
        const turnsBefore = (await rig.repos.turns.listByThread(rig.threadId)).length;

        // The production starter: the refusal comes before the switch applies.
        const starter = createRunStarter(
          { startDrain: (id) => rig.orchestrator.startDrain(id) },
          rig.deps.eventSink,
        );
        await starter.start(rig.threadId);

        // The refusal reserves nothing: no turn, no lease, no execution, no switch.
        expect((await rig.delivery.readPendingProjection(rig.threadId)).blocked).toEqual({
          reason: "credits_exhausted",
        });
        expect((await rig.repos.turns.listByThread(rig.threadId)).length).toBe(turnsBefore);
        expect(await db.select().from(schema.threadRunLeases)).toEqual([]);
        expect((await rig.runClaim.read(rig.threadId)).kind).toBe("asleep");
        expect(await threadMode(rig)).toBe("direct");
        expect(await switchTurns(rig)).toEqual([]);

        canStart.mockRestore();
        await starter.start(rig.threadId);
        const tail = (await settled(rig)).slice(turnsBefore);

        const reply = tail.find((turn) => turn.role === "assistant");
        expect(reply).toMatchObject({ status: "complete" });
        expect(await switchTurns(rig)).toHaveLength(1);
        expect(await threadMode(rig)).toBe("draft");
        // Usage returning clears the block with the last waiting row, and the reply's
        // execution ended once with its delivery recorded.
        expect((await rig.delivery.readPendingProjection(rig.threadId)).blocked).toBeUndefined();
        const execution = await identity(reply?.id);
        expect(execution.executionId).not.toBeNull();
        expect(await ended(execution.executionId)).toBe(true);
        expect(await deliveredBy(message.id)).toBe(reply?.id);
        expect(await db.select().from(schema.threadRunLeases)).toEqual([]);
      });

      /** A chat whose latest reply failed, and a hook that runs while a start waits on the run claim. */
      async function failedReplyRig() {
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
        await rig.send(rig.threadId, "Answer after the switch.");
        expect((await drainControls(rig)).status).toBe("error");
        await processDetachedWork.drain();
        const failed = await turnGraph(rig.repos.turns).latest(rig.threadId);
        if (!failed) throw new Error("Failed reply was not persisted");
        fail = false;
        const start = rig.runClaim.startExecution.bind(rig.runClaim);
        return {
          gateway,
          rig,
          failed,
          /** Runs `interleave` after Retry's eligibility reads, before its run-start boundary. */
          whileClaiming(interleave: () => Promise<unknown>) {
            rig.runClaim.startExecution = (threadId, executionId, settle) =>
              start(threadId, executionId, async () => {
                await settle();
                await interleave();
              });
          },
          /** Runs `interleave` once, at the run claim: before the start selects anything. */
          beforeSwitchApplies(interleave: () => Promise<unknown>) {
            let armed = true;
            rig.runClaim.startExecution = (threadId, executionId, settle) =>
              start(threadId, executionId, async () => {
                await settle();
                if (!armed) return;
                armed = false;
                await interleave();
              });
          },
          /**
           * Runs `probe` once, in the preparation that follows the start's selection while the
           * thread lock is held: the first history read under a granted advisory lock.
           */
          duringPreparation(probe: () => Promise<unknown>) {
            const list = rig.repos.blocks.listByThread.bind(rig.repos.blocks);
            let armed = true;
            rig.repos.blocks.listByThread = async (...args) => {
              const held = await db.execute(
                sql`select 1 from pg_locks where locktype = 'advisory' and granted and database = (select oid from pg_database where datname = current_database())`,
              );
              if (armed && held.length > 0) {
                armed = false;
                await probe();
              }
              return list(...args);
            };
          },
          retry: (replyTurnId: string) =>
            rig.orchestrator.retryReply({
              threadId: rig.threadId,
              failedTurnId: failed.id as never,
              replyTurnId: replyTurnId as never,
            }),
        };
      }

      it("applies a switch queued while Retry claims the chat with the Retry's reservation, or not at all", async () => {
        const { gateway, rig, failed, beforeSwitchApplies, duringPreparation, retry } =
          await failedReplyRig();
        beforeSwitchApplies(() => switchMode(rig, "draft"));
        const aborted = new AbortController();
        const abort = () => aborted.abort();
        duringPreparation(async () => abort());

        // A start discarded after it selected the due switch leaves the switch pending.
        await expect(
          rig.orchestrator.prepare({
            threadId: rig.threadId,
            drain: true,
            replyTurnId: crypto.randomUUID() as never,
            retryOf: failed.id as never,
            signal: aborted.signal,
          }),
        ).rejects.toThrow();
        await processDetachedWork.drain();
        expect(await switchTurns(rig)).toEqual([]);
        expect(await threadMode(rig)).toBe("direct");
        expect((await rig.delivery.selectPending(rig.threadId)).map((row) => row.intent)).toEqual([
          "control",
        ]);

        // The Retry that follows applies it with its own reservation: mid-preparation, no other
        // connection sees the mode, the switch turn or the acknowledgement.
        const midway: { mode?: string; switches?: number; pending?: number } = {};
        duringPreparation(async () => {
          // Plain queries on the pool: the start's own transaction is not this connection's.
          const [row] = await db.execute(sql`
            select
              (select ai_write_mode from threads where id = ${rig.threadId}) as mode,
              (select count(*)::int from turns where thread_id = ${rig.threadId}
                 and metadata->>'kind' = 'write_mode_switch') as switches,
              (select count(*)::int from thread_inbox_messages where thread_id = ${rig.threadId}
                 and intent = 'control' and delivered_at is null) as pending`);
          Object.assign(midway, row);
        });
        const replyTurnId = crypto.randomUUID();
        const started = await retry(replyTurnId);
        await processDetachedWork.drain();
        expect(midway).toEqual({ mode: "direct", switches: 0, pending: 1 });

        // The Retry starts a reply, so the switch applies first, though it arrived after Retry's reads.
        const [switchTurn] = await switchTurns(rig);
        expect(switchTurn).toBeDefined();
        expect(started).toMatchObject({
          created: true,
          turn: { prevTurnId: switchTurn?.id },
        });
        // The switch turn between them does not hide the failed reply's user turn.
        expect((await identity(replyTurnId)).reservedForUserTurnIds).toEqual([failed.prevTurnId]);
        expect(await rig.repos.turns.findById(replyTurnId as never)).toMatchObject({
          role: "assistant",
          status: "complete",
          prevTurnId: switchTurn?.id,
          writeMode: "draft",
        });
        expect(JSON.stringify(gateway.requests.at(-1)?.messages)).toContain(
          "The writer switched this chat to draft mode.",
        );
      });

      it("refuses a Retry a newer message overtook and leaves the queued switch pending", async () => {
        const { rig, beforeSwitchApplies, retry } = await failedReplyRig();
        // The switch is already queued when Retry starts; the message lands after Retry's
        // eligibility reads and before the switch applies, so applying would bury it.
        await switchMode(rig, "draft");
        expect(await switchTurns(rig)).toEqual([]);
        beforeSwitchApplies(async () => {
          await rig.send(rig.threadId, "A newer message");
        });

        const replyTurnId = crypto.randomUUID();
        await expect(retry(replyTurnId)).rejects.toMatchObject({ code: "reply_retry_unavailable" });

        expect(await switchTurns(rig)).toEqual([]);
        expect(await threadMode(rig)).toBe("direct");
        expect(await rig.repos.turns.findById(replyTurnId as never)).toBeNull();
        expect((await rig.delivery.selectPending(rig.threadId)).map((row) => row.intent)).toContain(
          "control",
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
        expect(await ended(empty.executionId)).toBe(false);

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
        // The turn cancel endpoint (`./mf thread cancel`, a handoff brief's Stop), not the chat's
        // Stop: it ends the compaction and leaves the message for the next execution. The chat's
        // Stop hands the message back instead (`stop-protocol.db.test.ts`).
        expect(await rig.orchestrator.cancel(rig.threadId, run.executionTurnId)).toBe("cancelled");
        summaryReleased.open();
        expect(await done).toMatchObject({ status: "cancelled" });
        await processDetachedWork.drain();
        if ((await rig.delivery.selectPending(rig.threadId)).length > 0) {
          await expect(rig.orchestrator.startDrain(rig.threadId)).rejects.toThrow(
            "Thread not found",
          );
          await processDetachedWork.drain();
        }

        // C's cancel ended E1 without delivering M1; the next execution did.
        expect(await rig.repos.turns.findById(run.executionTurnId)).toMatchObject({
          status: "cancelled",
        });
        expect(await ended(e1.executionId)).toBe(true);
        const turns = await settled(rig);
        const reply = turns.find(
          (turn) => turn.role === "assistant" && turn.position > (c?.position ?? 0),
        );
        const e2 = await identity(reply?.id);
        expect(e2.executionId).not.toBe(e1.executionId);
        expect(e2.reservedForUserTurnIds).toEqual([run.userTurnId]);
        expect(await deliveredBy(run.userTurnId)).toBe(reply?.id);
        expect(await ended(e2.executionId)).toBe(true);
        expect(await rig.runClaim.readOpenExecutionId(rig.threadId)).toBeNull();

        // E1's end precedes E2's first reserved turn.
        expect(reply?.position ?? 0).toBeGreaterThan(c?.position ?? 0);
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
        const f1 = await turnGraph(rig.repos.turns).latest(rig.threadId);
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
        // A replay answers the record as of the replay: the open execution is this Retry's.
        expect(await rig.orchestrator.retryReply(retry)).toMatchObject({
          created: false,
          turn: null,
          executionId: accepted.executionId,
          runState: { execution: { executionId: accepted.executionId } },
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
        expect(await ended(accepted.executionId)).toBe(true);
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
        const failed = await turnGraph(rig.repos.turns).latest(rig.threadId);
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
        expect(await ended(answer.executionId)).toBe(true);
        expect(await leaseRow(rig.threadId)).toBeUndefined();
      });

      it("answers an accepted same-id Retry replay after shutdown starts", async () => {
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
        const graph = turnGraph(rig.repos.turns);
        const latest = graph.latest.bind(graph);
        graph.latest = async (threadId) => {
          graph.latest = latest;
          latestRead.open();
          await latestReleased.promise;
          return latest(threadId);
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
        // Shutdown stops new work; it never denies work already accepted.
        rig.deps.shutdown.started = true;
        latestReleased.open();

        expect(await replay).toMatchObject({
          created: false,
          turn: { id: retry.replyTurnId },
          executionId: accepted.executionId,
        });
        // Another tab's request id is still refused.
        await expect(
          rig.orchestrator.retryReply({ ...retry, replyTurnId: crypto.randomUUID() as never }),
        ).rejects.toMatchObject({ code: "runtime_shutting_down" });
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
        expect(await ended(e1.executionId)).toBe(false);
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
        expect(await ended(e1.executionId)).toBe(true);
        const turns = await settled(rig);
        expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
        expect((await identity(turns.at(-1)?.id)).executionId).not.toBe(e1.executionId);
      });

      it("settles an expired lease with no unsettled turn from the repair lane", async () => {
        const rig = await manualFixture();
        // A crash after repair committed the turn's error but before the end:
        // the turn carries the execution, the expired row remains.
        const executionId = crypto.randomUUID();
        const leaf = await turnGraph(rig.repos.turns).latest(rig.threadId);
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
          publisher: { publish: async () => "already" as const },
          eventSink: rig.deps.eventSink,
        });
        await repair.sweep(10);

        expect(await leaseRow(rig.threadId)).toBeUndefined();
        expect(await leaseRow(legacy.id)).toBeUndefined();
        expect(await ended(executionId)).toBe(true);
        expect(await ended("run-before-identity")).toBe(false);
        expect(await rig.runClaim.readOpenExecutionId(rig.threadId)).toBeNull();
      });
    });
  });
