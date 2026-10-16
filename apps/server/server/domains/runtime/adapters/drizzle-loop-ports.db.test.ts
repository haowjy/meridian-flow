/** Consolidated test contracts; each block retains its original fixture scope. */

import type { ThreadId } from "@meridian/contracts/runtime";
import { eq } from "drizzle-orm";
import { describe as __mergedSuite, afterAll, beforeEach, expect, it } from "vitest";
import { journalEventsByThread } from "../../../test-support/journal-events.js";
import { releaseLeaseUnderLock } from "../../../test-support/release-lease.js";
import { createInMemoryEventSink } from "../../observability/index.js";
import type { MessageDraft } from "../loop/ports.js";
import { readRunStateAtHead } from "./drizzle-run-state.js";

__mergedSuite("drizzle-loop-ports.db.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/adapters/drizzle-loop-ports.db.test.ts.
  const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

  const DATABASE_URL = process.env.DATABASE_URL;

  const USER_ID = "00000000-0000-4000-8000-0000000008a1";

  const PROJECT_ID = "00000000-0000-4000-8000-0000000008a2";

  const THREAD_A = "00000000-0000-4000-8000-0000000008a3" as ThreadId;

  const THREAD_B = "00000000-0000-4000-8000-0000000008a4" as ThreadId;

  function required<T>(value: T | null): T {
    if (value === null) throw new Error("expected a value");
    return value;
  }

  if (!RUN_DB_TESTS || !DATABASE_URL) {
    __mergedSuite.skip("loop ports (postgres)", () => {});
  } else {
    __mergedSuite("loop ports (postgres)", async () => {
      const { createDb } = await import("@meridian/database");
      const schema = await import("@meridian/database/schema");
      const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
        "@meridian/database/__test-support__/db-fixtures"
      );
      const { deleteDrizzleRows } = await import("../../../test-support/drizzle-reset.js");
      const { createLockedDrizzleInbox } = await import("../../../test-support/locked-inbox.js");
      const { createTestDrizzleDelivery } = await import(
        "../loop/__tests__/test-drizzle-delivery.js"
      );
      const { createDrizzleRunClaim } = await import("./drizzle-run-claim.js");
      const { createDrizzleRepositoriesForTest } = await import(
        "../../threads/adapters/drizzle/repositories.js"
      );
      const { runInDrizzleTransaction } = await import("../../../shared/drizzle-transaction.js");
      assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
      const db = createDb(DATABASE_URL, { max: 6 });
      beforeEach(async () => {
        await deleteDrizzleRows(db, [schema.users]);
        await db.insert(schema.users).values(conformanceUserValues(USER_ID, "loop-ports"));
        await db.insert(schema.projects).values({
          id: PROJECT_ID,
          userId: USER_ID,
          name: "Loop Ports",
          slug: "loop-ports",
        });
        await db.insert(schema.threads).values({
          rootThreadId: THREAD_A,
          id: THREAD_A,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: "Thread A",
        });
        await db.insert(schema.threads).values({
          rootThreadId: THREAD_B,
          id: THREAD_B,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: "Thread B",
        });
      });
      afterAll(async () => {
        await db.close();
      });
      // The run-state records the chat's journal holds, oldest first.
      const runStateJournal = async (threadId: ThreadId) =>
        (await journalEventsByThread(db, threadId)).filter(
          (event) => event.eventType === "run_state.changed",
        );
      function message(key: string, threadId: ThreadId = THREAD_A): MessageDraft {
        return {
          threadId,
          intent: "message",
          provenance: { kind: "writer", actorId: USER_ID },
          body: { kind: "text", text: key },
          idempotencyKey: key,
        };
      }
      function notice(key: string, threadId: ThreadId = THREAD_A): MessageDraft {
        return {
          threadId,
          intent: "notice",
          provenance: { kind: "system", source: "work" },
          body: { kind: "context", parts: [{ source: "work", text: key }] },
          idempotencyKey: key,
        };
      }
      it("acks delivered messages and redelivers the unacked", async () => {
        const inbox = createLockedDrizzleInbox(db);
        const first = await inbox.enqueue(message("a1"));
        await inbox.enqueue(message("a2"));
        await inbox.ack(THREAD_A, [first.id]);
        const redelivered = await inbox.selectPending(THREAD_A);
        expect(redelivered.map((message) => message.idempotencyKey)).toEqual(["a2"]);
      });
      it("keeps the same idempotency key distinct across threads", async () => {
        const inbox = createLockedDrizzleInbox(db);
        const first = await inbox.enqueue(message("shared-key", THREAD_A));
        const second = await inbox.enqueue(message("shared-key", THREAD_B));
        expect(second.id).not.toBe(first.id);
        expect(second.threadId).toBe(THREAD_B);
        expect(await inbox.selectPending(THREAD_B)).toHaveLength(1);
      });
      it("lists distinct pending-message threads oldest first and excludes notices", async () => {
        const inbox = createLockedDrizzleInbox(db);
        await inbox.enqueue(notice("s1", THREAD_A));
        await inbox.enqueue(message("a1", THREAD_A));
        await inbox.enqueue(message("b1", THREAD_B));
        await inbox.enqueue(notice("s2", THREAD_B));
        expect(await inbox.pendingMessageThreads(10)).toEqual([THREAD_A, THREAD_B]);
        expect(await inbox.pendingMessageThreads(1, THREAD_A)).toEqual([THREAD_B]);
        expect(await inbox.pendingMessageThreads(1, THREAD_B)).toEqual([]);
      });
      it("discovers queued messages behind pending handoff seeds for ordinary repair", async () => {
        const repos = createDrizzleRepositoriesForTest(db);
        const runClaim = createDrizzleRunClaim(db, { holderId: "handoff-repair" });
        const inbox = createLockedDrizzleInbox(db);
        const delivery = createTestDrizzleDelivery(db, { repos, runClaim });
        const seed = await repos.turns.create({
          threadId: THREAD_A,
          role: "system",
          origin: "system",
          status: "pending",
          metadata: {
            kind: "derivation_seed",
            derivation: "handoff",
            sourceThreadId: THREAD_B,
            sourceRef: "p1",
            sourceTitle: "Source",
            cutoffTurnId: crypto.randomUUID(),
          },
        });
        const waiting = await inbox.enqueue(message("wait-for-seed", THREAD_A));
        await inbox.enqueue(message("other-thread", THREAD_B));
        expect(await delivery.pendingMessageThreads(10)).toEqual([THREAD_A, THREAD_B]);
        expect(await inbox.selectPending(THREAD_A)).toMatchObject([{ id: waiting.id }]);
        expect(await runClaim.holder(THREAD_A)).toBeNull();
        const repairLease = required(
          await runClaim.startExecution(THREAD_A, crypto.randomUUID(), () =>
            delivery.settleStaleExecution(THREAD_A),
          ),
        );
        expect(await repos.turns.findById(seed.id)).toMatchObject({
          status: "error",
          metadata: { reason: "interrupted", phase: "recovery" },
        });
        await releaseLeaseUnderLock(db, runClaim, repairLease);
        expect(await delivery.pendingMessageThreads(10)).toEqual([THREAD_A, THREAD_B]);
        expect(await inbox.selectPending(THREAD_A)).toMatchObject([{ id: waiting.id }]);
      });
      it("retires a failed compaction successor before crash recovery", async () => {
        const { failCompactionSuccessor } = await import("../loop/compaction-successor.js");
        const { createRuntimeHarness } = await import("../loop/__tests__/runtime-harness.js");
        const { createOrphanReportRepair } = await import("../spawn/orphan-report-repair.js");
        const { createDrizzleEventJournalWriter } = await import("../../threads/index.js");
        const repos = createDrizzleRepositoriesForTest(db);
        const authority = createDrizzleRunClaim(db);
        const eventWriter = createDrizzleEventJournalWriter(db);
        const delivery = createTestDrizzleDelivery(db, { repos, runClaim: authority, eventWriter });
        const adopted = await delivery.enqueue(message("failed-summary"));
        await repos.turns.create({
          id: adopted.id,
          threadId: THREAD_A,
          role: "user",
          origin: "writer",
          status: "complete",
        });
        const placeholder = await repos.turns.create({
          threadId: THREAD_A,
          prevTurnId: adopted.id,
          role: "compaction",
          origin: "system",
          status: "pending",
        });
        // A sweep can capture C before its owner commits the failure landing.
        const candidates = (await repos.turns.listPendingPlaceholders(100)).filter(
          (turn) => turn.id === placeholder.id,
        );
        const lease = {
          threadId: THREAD_A,
          executionId: crypto.randomUUID(),
          holderId: "dead-worker",
        };
        await db.insert(schema.threadRunLeases).values({
          ...lease,
          turnId: placeholder.id,
          boundTurnIds: [placeholder.id],
          adoptedMessageIds: [adopted.id],
          expiresAt: new Date(Date.now() + 60000),
        });
        const fail = (boundaryDelivery: typeof delivery) =>
          failCompactionSuccessor({
            deps: createRuntimeHarness({
              repos,
              runClaim: authority,
              delivery: boundaryDelivery,
              eventWriter,
            }).deps,
            threadId: THREAD_A,
            placeholder,
            settleResponses: async () => {},
            failure: new Error("Summary provider failed"),
            boundary: {
              lease,
              currentTurn: placeholder,
              continueTask: true,
              knownTurnIds: new Set([adopted.id, placeholder.id]),
              expectedLeafTurnId: placeholder.id,
              current: { kind: "assistant" },
              prepareNextContext: async () => {
                throw new Error("Unexpected optional compaction path");
              },
            },
          });
        const failing = createTestDrizzleDelivery(db, {
          repos,
          runClaim: authority,
          eventWriter: {
            async appendEvent(threadId, event) {
              if (event.type === "run_state.changed") throw new Error("projection unavailable");
              return eventWriter.appendEvent(threadId, event);
            },
          },
        });
        await expect(fail(failing)).rejects.toThrow();
        expect((await repos.turns.findById(placeholder.id))?.status).toBe("pending");
        expect(await repos.turns.listByThread(THREAD_A)).toHaveLength(2);
        expect(await delivery.selectPending(THREAD_A)).toMatchObject([{ id: adopted.id }]);
        expect(await db.select().from(schema.threadRunLeases)).toMatchObject([
          {
            ...lease,
            turnId: placeholder.id,
            adoptedMessageIds: [adopted.id],
          },
        ]);
        const failed = await fail(delivery);
        expect((await repos.turns.findById(placeholder.id))?.status).toBe("error");
        expect(failed.next.status).toBe("error");
        expect(await db.select().from(schema.threadRunLeases)).toEqual([]);
        // No failure-close or run-session cleanup: the worker died after commit.
        await createOrphanReportRepair({
          repos: {
            ...repos,
            turns: {
              ...repos.turns,
              async listPendingPlaceholders() {
                return candidates;
              },
            },
          },
          inbox: delivery,
          authority,
          eventWriter,
          settleStaleExecution: delivery.settleStaleExecution,
          retireOrphanedReply: delivery.retireOrphanedReply,
          clearOrphanedTurn: delivery.clearOrphanedTurn,
          publisher: {
            async publish() {
              return "already" as const;
            },
          },
          eventSink: createInMemoryEventSink(),
        }).sweep(10);
        expect(await authority.read(THREAD_A)).toEqual({ kind: "asleep" });
        expect(await delivery.selectPending(THREAD_A)).toEqual([]);
        expect(await db.select().from(schema.threadRunLeases)).toEqual([]);
        expect(await repos.turns.listUnsettledForThread(THREAD_A)).toEqual([]);
      });
      it("publishes idle after orphan repair commits the turn and stale lease deletion", async () => {
        const { createOrphanReportRepair } = await import("../spawn/orphan-report-repair.js");
        const { createDrizzleEventJournalWriter } = await import("../../threads/index.js");
        const repos = createDrizzleRepositoriesForTest(db);
        const turn = await repos.turns.create({
          threadId: THREAD_A,
          role: "assistant",
          origin: "assistant",
          status: "streaming",
        });
        const deadRun = crypto.randomUUID();
        await db.insert(schema.threadRunLeases).values({
          threadId: THREAD_A,
          executionId: deadRun,
          holderId: "dead-worker",
          turnId: turn.id,
          boundTurnIds: [turn.id],
          expiresAt: new Date(Date.now() + 60000),
        });
        const authority = createDrizzleRunClaim(db);
        const published: unknown[] = [];
        const publishStatus = async (threadId: ThreadId) => {
          // Read through the root connection, as a subscriber would after commit.
          published.push({
            status: await authority.read(threadId),
            turns: await db.select({ status: schema.turns.status }).from(schema.turns),
            leases: await db.select().from(schema.threadRunLeases),
          });
        };
        const delivery = createTestDrizzleDelivery(db, {
          repos,
          runClaim: authority,
          publishStatus,
        });
        const repairDeps = {
          repos,
          inbox: delivery,
          authority,
          eventWriter: createDrizzleEventJournalWriter(db),
          settleStaleExecution: delivery.settleStaleExecution,
          retireOrphanedReply: delivery.retireOrphanedReply,
          clearOrphanedTurn: delivery.clearOrphanedTurn,
          publisher: {
            async publish() {
              return "already" as const;
            },
          },
          eventSink: createInMemoryEventSink(),
        };
        const failing = createTestDrizzleDelivery(db, {
          repos,
          runClaim: authority,
          publishStatus,
          eventWriter: {
            async appendEvent() {
              throw new Error("projection unavailable");
            },
          },
        });
        await createOrphanReportRepair({
          ...repairDeps,
          settleStaleExecution: failing.settleStaleExecution,
        }).sweep(10);
        expect((await repos.turns.findById(turn.id))?.status).toBe("streaming");
        expect(await authority.holder(THREAD_A)).toBe(deadRun);
        expect(published).toEqual([]);
        const repair = createOrphanReportRepair(repairDeps);
        await repair.sweep(10);
        expect(await db.select().from(schema.threadRunLeases)).toEqual([]);
        expect(published).toEqual([
          { status: { kind: "asleep" }, turns: [{ status: "error" }], leases: [] },
        ]);
        const next = required(await authority.startExecution(THREAD_A, "next-run", async () => {}));
        await authority.release(next);
      });
      it("carries one thread lease through acquire, renew, release, and a stale release after reacquire", async () => {
        const first = createDrizzleRunClaim(db, { holderId: "holder-1" });
        const second = createDrizzleRunClaim(db, { holderId: "holder-2" });
        const lease = required(await first.startExecution(THREAD_A, "run-1", async () => {}));
        expect(await second.startExecution(THREAD_A, "run-contender", async () => {})).toBeNull();
        expect(await first.holder(THREAD_A)).toBe("run-1");
        expect(await first.read(THREAD_A)).toEqual({
          kind: "awake",
          phase: "generating",
          cancelRequested: false,
        });
        expect(await first.renew(lease)).toBe(true);
        await first.publish(lease, "waiting");
        expect(await first.read(THREAD_A)).toEqual({
          kind: "awake",
          phase: "waiting",
          cancelRequested: false,
        });
        await first.release(lease);
        expect(await first.holder(THREAD_A)).toBeNull();
        expect(await first.read(THREAD_A)).toEqual({ kind: "asleep" });
        expect(await first.renew(lease)).toBe(false);
        const runTwo = required(await first.startExecution(THREAD_A, "run-2", async () => {}));
        await first.release(lease);
        await first.release(lease);
        expect(await first.holder(THREAD_A)).toBe("run-2");
        expect(await first.read(THREAD_A)).toEqual({
          kind: "awake",
          phase: "generating",
          cancelRequested: false,
        });
        expect(await second.startExecution(THREAD_A, "run-3", async () => {})).toBeNull();
        await first.release(runTwo);
        expect(await first.holder(THREAD_A)).toBeNull();
        const runThree = required(await second.startExecution(THREAD_A, "run-3", async () => {}));
        await second.release(runThree);
      });
      it("stores one current tool per live lease and identifies repeated writes as unchanged", async () => {
        const authority = createDrizzleRunClaim(db, { holderId: "current-tool" });
        const lease = required(
          await authority.startExecution(THREAD_A, "run-tool", async () => {}),
        );
        const first = {
          toolCallId: "call-1",
          toolName: "spawn",
          input: { agent: "researcher", prompt: "Find sources" },
        };
        expect(await authority.setCurrentTool(lease, first)).toBe(true);
        expect(await authority.setCurrentTool(lease, first)).toBe(false);
        const next = { toolCallId: "call-2", toolName: "thread_report", input: { ref: "p3" } };
        expect(await authority.setCurrentTool(lease, next)).toBe(true);
        expect((await authority.readMany([THREAD_A])).get(THREAD_A)?.currentTool).toEqual(next);
        await authority.release(lease);
        expect((await authority.readMany([THREAD_A])).has(THREAD_A)).toBe(false);
        expect(await authority.setCurrentTool(lease, first)).toBe(false);
      });
      it("keeps the physical claim and lease when terminal release rolls back", async () => {
        const first = createDrizzleRunClaim(db, { holderId: "holder-1" });
        const second = createDrizzleRunClaim(db, { holderId: "holder-2" });
        const lease = required(await first.startExecution(THREAD_A, "run-1", async () => {}));
        await expect(
          runInDrizzleTransaction(db, async () => {
            await first.release(lease);
            throw new Error("terminal rollback");
          }),
        ).rejects.toThrow("terminal rollback");
        expect(await first.holder(THREAD_A)).toBe("run-1");
        expect(await second.startExecution(THREAD_A, "run-2", async () => {})).toBeNull();
        await first.release(lease);
        const next = required(await second.startExecution(THREAD_A, "run-2", async () => {}));
        await second.release(next);
      });
      it("keeps the physical claim until the terminal transaction commits", async () => {
        const first = createDrizzleRunClaim(db, { holderId: "holder-1" });
        const second = createDrizzleRunClaim(db, { holderId: "holder-2" });
        const lease = required(await first.startExecution(THREAD_A, "run-1", async () => {}));
        let releaseTransaction!: () => void;
        let releasedInTransaction!: () => void;
        const released = new Promise<void>((resolve) => {
          releasedInTransaction = resolve;
        });
        const continueTransaction = new Promise<void>((resolve) => {
          releaseTransaction = resolve;
        });
        const completion = runInDrizzleTransaction(db, async () => {
          await first.release(lease);
          releasedInTransaction();
          await continueTransaction;
        });
        await released;
        expect(await second.startExecution(THREAD_A, "run-2", async () => {})).toBeNull();
        releaseTransaction();
        await completion;
        const next = required(await second.startExecution(THREAD_A, "run-2", async () => {}));
        await second.release(next);
      });
      it("excludes short claims and executions locally and across adapters without fake leases", async () => {
        const claim = createDrizzleRunClaim(db);
        const remote = createDrizzleRunClaim(db);
        await claim.withExclusiveThread(THREAD_A, async () => {
          expect(await claim.read(THREAD_A)).toEqual({ kind: "asleep" });
          expect(await claim.withExclusiveThread(THREAD_A, async () => true)).toBeNull();
          expect(await claim.startExecution(THREAD_A, "local", async () => {})).toBeNull();
          expect(await remote.withExclusiveThread(THREAD_A, async () => true)).toBeNull();
          expect(await remote.startExecution(THREAD_A, "remote", async () => {})).toBeNull();
          expect(await claim.withExclusiveThread(THREAD_B, async () => true)).toBe(true);
        });
        const lease = required(await claim.startExecution(THREAD_A, "live", async () => {}));
        expect(await claim.withExclusiveThread(THREAD_A, async () => true)).toBeNull();
        expect(await remote.withExclusiveThread(THREAD_A, async () => true)).toBeNull();
        await releaseLeaseUnderLock(db, claim, lease);
        expect(await remote.withExclusiveThread(THREAD_A, async () => true)).toBe(true);
      });
      __mergedSuite("RuntimeDelivery atomic transitions", () => {
        const failure = {
          async appendEvent() {
            throw new Error("projection unavailable");
          },
        };
        async function assistant() {
          const { createDrizzleRepositoriesForTest } = await import(
            "../../threads/adapters/drizzle/repositories.js"
          );
          const repos = createDrizzleRepositoriesForTest(db);
          return {
            repos,
            turn: await repos.turns.create({
              threadId: THREAD_A,
              role: "assistant",
              origin: "assistant",
              status: "streaming",
            }),
          };
        }
        it("withdraws the last blocked control atomically without poisoning later work", async () => {
          const { repos, turn } = await assistant();
          await db
            .update(schema.turns)
            .set({ status: "complete" })
            .where(eq(schema.turns.id, turn.id));
          const runClaim = createDrizzleRunClaim(db);
          const lease = required(await runClaim.startExecution(THREAD_A, "usage", async () => {}));
          try {
            const delivery = createTestDrizzleDelivery(db, { repos, runClaim });
            const first = await delivery.enqueue({
              ...message("compact"),
              intent: "control",
              body: { kind: "compact" },
            });
            const second = await delivery.enqueue({
              ...message("compact-2"),
              intent: "control",
              body: { kind: "compact" },
            });
            await delivery.enqueue(notice("remaining-notice"));
            await delivery.blockForUsage(lease);
            await delivery.withdrawControl(THREAD_A, first.id);
            expect((await readRunStateAtHead(db, THREAD_A)).blocked).not.toBeNull();
            await expect(
              createTestDrizzleDelivery(db, {
                repos,
                runClaim,
                eventWriter: failure,
              }).withdrawControl(THREAD_A, second.id),
            ).rejects.toThrow("projection unavailable");
            expect((await readRunStateAtHead(db, THREAD_A)).blocked).not.toBeNull();
            expect((await delivery.selectPending(THREAD_A)).map((row) => row.id)).toContain(
              second.id,
            );
            expect(await delivery.withdrawControl(THREAD_A, second.id)).toMatchObject({
              outcome: "withdrawn",
            });
            const [thread] = await db
              .select()
              .from(schema.threads)
              .where(eq(schema.threads.id, THREAD_A));
            expect(thread?.inboxBlockedReason).toBeNull();
            expect((await runStateJournal(THREAD_A)).at(-1)?.payload).toMatchObject({
              runState: { blocked: null },
            });
            // A refused wake with only notices cannot install a new orphan block.
            await delivery.blockForUsage(lease);
            const [empty] = await db
              .select()
              .from(schema.threads)
              .where(eq(schema.threads.id, THREAD_A));
            expect(empty?.inboxBlockedReason).toBeNull();
            await delivery.enqueue(message("funded"));
            expect((await readRunStateAtHead(db, THREAD_A)).blocked).toBeNull();
          } finally {
            await releaseLeaseUnderLock(db, runClaim, lease);
          }
        });
        it("persists the usage block and publishes it until the next run starts", async () => {
          const { repos, turn } = await assistant();
          const runClaim = createDrizzleRunClaim(db);
          const lease = required(await runClaim.startExecution(THREAD_A, "usage", async () => {}));
          const delivery = createTestDrizzleDelivery(db, { repos, runClaim });
          const row = await delivery.enqueue(message("kept"));
          await expect(
            createTestDrizzleDelivery(db, {
              repos,
              runClaim,
              eventWriter: failure,
            }).blockForUsage(lease),
          ).rejects.toThrow("projection unavailable");
          expect((await readRunStateAtHead(db, THREAD_A)).blocked).toBeNull();
          await delivery.blockForUsage(lease);
          await releaseLeaseUnderLock(db, runClaim, lease);
          const saved = await readRunStateAtHead(db, THREAD_A);
          const { buildThreadSnapshot } = await import("../../threads/thread-snapshot.js");
          const snapshot = await buildThreadSnapshot(
            repos,
            {
              async headSeq() {
                return 0n;
              },
              async readModelProjectionWatermark() {
                return 0n;
              },
            },
            {
              async read() {
                return { kind: "asleep" as const };
              },
              async readMany() {
                return new Map();
              },
              readRunningTurnId: runClaim.readRunningTurnId,
              readRunState: (threadId) => readRunStateAtHead(db, threadId),
            },
            THREAD_A,
          );
          expect(snapshot.liveState.runState.blocked).toEqual({
            reason: "credits_exhausted",
          });
          expect(saved.blocked).toEqual({ reason: "credits_exhausted" });
          expect(saved.items.map((item) => item.id)).toEqual([row.id]);
          const events = await runStateJournal(THREAD_A);
          expect(events.at(-1)?.payload).toMatchObject({
            runState: { blocked: { reason: "credits_exhausted" } },
          });
          const nextLease = required(
            await runClaim.startExecution(THREAD_A, "restored", async () => {}),
          );
          await delivery.adoptBatch(nextLease, async () => ({
            value: undefined,
            turnKind: "assistant" as const,
            turnId: turn.id,
            messageIds: [row.id],
          }));
          expect((await readRunStateAtHead(db, THREAD_A)).blocked).toBeNull();
          expect((await runStateJournal(THREAD_A)).at(-1)?.payload).toMatchObject({
            runState: { blocked: null },
          });
          await releaseLeaseUnderLock(db, runClaim, nextLease);
        });
        it("rolls back enqueue when projection fails; commits one replacement before the wake", async () => {
          const { createDrizzleEventJournalWriter } = await import("../../threads/index.js");
          const writer = createDrizzleEventJournalWriter(db);
          let wakes = 0;
          const visible: number[][] = [];
          const runStarter = {
            async start() {
              wakes++;
              visible.push([
                (await db.select().from(schema.threadInboxMessages)).length,
                (await db.select().from(schema.eventJournal)).length,
              ]);
            },
          };
          await expect(
            createTestDrizzleDelivery(db, { eventWriter: failure, runStarter }).enqueue(
              message("atomic"),
            ),
          ).rejects.toThrow("projection unavailable");
          expect(await db.select().from(schema.threadInboxMessages)).toHaveLength(0);
          expect(wakes).toBe(0);
          const delivery = createTestDrizzleDelivery(db, { eventWriter: writer, runStarter });
          const accepted = await delivery.enqueue(message("atomic"));
          expect(wakes).toBe(1);
          expect((await delivery.enqueue(message("atomic"))).id).toBe(accepted.id);
          expect(await db.select().from(schema.threadInboxMessages)).toHaveLength(1);
          expect(wakes).toBe(2);
          // The record is journaled before the wake; the replay changes no row, so journals no second.
          expect(visible).toEqual([
            [1, 1],
            [1, 1],
          ]);
        });
        it("rolls back initial adoption, response+ack and terminal+release on projection failure", async () => {
          const { currentDrizzleDb } = await import("../../../shared/drizzle-transaction.js");
          const { repos, turn } = await assistant();
          const runClaim = createDrizzleRunClaim(db);
          const remote = createDrizzleRunClaim(db);
          const lease = required(await runClaim.startExecution(THREAD_A, "atomic", async () => {}));
          const delivery = createTestDrizzleDelivery(db, { repos, runClaim });
          const failing = createTestDrizzleDelivery(db, {
            repos,
            runClaim,
            eventWriter: failure,
          });
          const row = await delivery.enqueue(message("batch"));
          const prepare = async () => ({
            value: undefined,
            turnKind: "assistant" as const,
            turnId: turn.id,
            messageIds: [row.id],
          });
          await expect(failing.adoptBatch(lease, prepare)).rejects.toThrow(
            "projection unavailable",
          );
          expect(await runClaim.readRunningTurnId(THREAD_A)).toBeNull();
          await delivery.adoptBatch(lease, prepare);
          const response = () =>
            currentDrizzleDb(db)
              .update(schema.turns)
              .set({ responseCount: 1 })
              .where(eq(schema.turns.id, turn.id));
          await expect(failing.ackWithResponse(lease, [row.id], turn, response)).rejects.toThrow(
            "projection unavailable",
          );
          expect((await repos.turns.findById(turn.id))?.responseCount).toBe(0);
          expect((await delivery.readPendingProjection(THREAD_A)).run?.messageIds).toEqual([
            row.id,
          ]);
          expect(await delivery.selectPending(THREAD_A)).toHaveLength(1);
          await delivery.ackWithResponse(lease, [row.id], turn, response);
          expect(await delivery.selectPending(THREAD_A)).toHaveLength(0);
          const terminal = {
            lease,
            turnId: turn.id,
            cause: { kind: "success" as const, finishReason: "end_turn" as const },
          };
          await expect(failing.close(terminal)).rejects.toThrow("projection unavailable");
          expect((await repos.turns.findById(turn.id))?.status).toBe("streaming");
          expect(await runClaim.readRunningTurnId(THREAD_A)).toBe(turn.id);
          expect(await remote.startExecution(THREAD_A, "blocked", async () => {})).toBeNull();
          expect((await delivery.close(terminal)).kind).toBe("completed");
          expect(await remote.withExclusiveThread(THREAD_A, async () => true)).toBe(true);
        });
        it.each([
          "mismatch",
          "expiry",
        ])("keeps response ack tied to the held receipt (%s)", async (variant) => {
          const { repos, turn } = await assistant();
          const runClaim = createDrizzleRunClaim(db);
          const lease = required(
            await runClaim.startExecution(THREAD_A, "receipt", async () => {}),
          );
          const delivery = createTestDrizzleDelivery(db, { repos, runClaim });
          try {
            const row = await delivery.enqueue(message("receipt"));
            await delivery.adoptBatch(lease, async () => ({
              value: undefined,
              turnKind: "assistant" as const,
              turnId: turn.id,
              messageIds: [row.id],
            }));
            if (variant === "mismatch") {
              await expect(
                delivery.ackWithResponse(
                  lease,
                  [crypto.randomUUID()],
                  turn,
                  async () => "response",
                ),
              ).rejects.toThrow();
              expect((await delivery.readPendingProjection(THREAD_A)).run?.messageIds).toEqual([
                row.id,
              ]);
            } else {
              await db
                .update(schema.threadRunLeases)
                .set({ expiresAt: new Date(0) })
                .where(eq(schema.threadRunLeases.threadId, THREAD_A));
              await expect(
                delivery.ackWithResponse(lease, [row.id], turn, async () => "paid response"),
              ).resolves.toBe("paid response");
              expect(await delivery.selectPending(THREAD_A)).toHaveLength(0);
            }
          } finally {
            await releaseLeaseUnderLock(db, runClaim, lease);
          }
        });
        it("honors a remote cancel before terminal close with a pending followup", async () => {
          const { repos, turn } = await assistant();
          const runClaim = createDrizzleRunClaim(db);
          const remote = createDrizzleRunClaim(db);
          const lease = required(
            await runClaim.startExecution(THREAD_A, "remote-cancel", async () => {}),
          );
          const delivery = createTestDrizzleDelivery(db, { repos, runClaim });
          try {
            await delivery.adoptBatch(lease, async () => ({
              value: undefined,
              turnKind: "assistant" as const,
              turnId: turn.id,
              messageIds: [],
            }));
            const pending = await delivery.enqueue(message("next-run"));
            expect(await remote.cancelExecution(THREAD_A, turn.id)).toBe(true);
            const closed = await delivery.close({
              lease,
              turnId: turn.id,
              cause: { kind: "success", finishReason: "end_turn" },
              continueWith: {
                lease,
                currentTurn: turn,
                current: { kind: "assistant" },
                knownTurnIds: new Set([turn.id]),
                expectedLeafTurnId: turn.id,
                prepareNextContext: async () => ({
                  events: [],
                  turns: [],
                  blocks: [],
                  requiresSplit: false,
                }),
              },
            });
            expect(closed.kind).toBe("completed");
            expect((await repos.turns.findById(turn.id))?.status).toBe("cancelled");
            expect((await delivery.selectPending(THREAD_A)).map((row) => row.id)).toEqual([
              pending.id,
            ]);
          } finally {
            await releaseLeaseUnderLock(db, runClaim, lease);
          }
        });
        it("serializes a racing enqueue after terminal commit and leaves it recoverable", async () => {
          const { repos, turn } = await assistant();
          const { createDrizzleEventJournalWriter } = await import("../../threads/index.js");
          const writer = createDrizzleEventJournalWriter(db);
          const runClaim = createDrizzleRunClaim(db);
          const lease = required(await runClaim.startExecution(THREAD_A, "race", async () => {}));
          let entered!: () => void, release!: () => void;
          const reached = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const delivery = createTestDrizzleDelivery(db, { repos, runClaim });
          await delivery.adoptBatch(lease, async () => ({
            value: undefined,
            turnKind: "assistant" as const,
            turnId: turn.id,
            messageIds: [],
          }));
          const closing = createTestDrizzleDelivery(db, {
            repos,
            runClaim,
            eventWriter: {
              async appendEvent(threadId, event) {
                if (event.type === "run_state.changed") {
                  entered();
                  await gate;
                }
                return writer.appendEvent(threadId, event);
              },
            },
          }).close({
            lease,
            turnId: turn.id,
            cause: { kind: "success", finishReason: "end_turn" },
          });
          await reached;
          const queued = delivery.enqueue(message("racing"));
          release();
          await closing;
          await queued;
          expect(await runClaim.holder(THREAD_A)).toBeNull();
          expect(await delivery.pendingMessageThreads(10)).toEqual([THREAD_A]);
        });
      });
    });
  }
});

__mergedSuite("drizzle-run-state.db.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/adapters/drizzle-run-state.db.test.ts.
  const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

  const DATABASE_URL = process.env.DATABASE_URL;

  const USER_ID = "00000000-0000-4000-8000-0000000009a1";

  const PROJECT_ID = "00000000-0000-4000-8000-0000000009a2";

  const THREAD_A = "00000000-0000-4000-8000-0000000009a3" as ThreadId;

  const THREAD_B = "00000000-0000-4000-8000-0000000009a4" as ThreadId;

  if (!RUN_DB_TESTS || !DATABASE_URL) {
    __mergedSuite.skip("run-state publication (postgres)", () => {});
  } else {
    __mergedSuite("run-state publication (postgres)", async () => {
      const { createDb } = await import("@meridian/database");
      const schema = await import("@meridian/database/schema");
      const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
        "@meridian/database/__test-support__/db-fixtures"
      );
      const { deleteDrizzleRows } = await import("../../../test-support/drizzle-reset.js");
      const { createDrizzleEventJournalWriter } = await import(
        "../../threads/adapters/drizzle/event-writer.js"
      );
      const { eventSeqForJournalEvent } = await import("../../threads/index.js");
      const {
        enlistDrizzleTransactionParticipant,
        runInDrizzleSavepoint,
        runInDrizzleTransaction,
      } = await import("../../../shared/drizzle-transaction.js");
      const { createDrizzleInbox } = await import("./drizzle-inbox.js");
      const { createDrizzleThreadLock } = await import("./drizzle-thread-lock.js");
      const { answerRunState, markRunStateChanged, publishRunState } = await import(
        "./drizzle-run-state.js"
      );
      assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
      const db = createDb(DATABASE_URL, { max: 6 });
      const lock = createDrizzleThreadLock(db, createDrizzleEventJournalWriter(db));
      const inbox = createDrizzleInbox(db);
      beforeEach(async () => {
        await deleteDrizzleRows(db, [schema.users]);
        await db.insert(schema.users).values(conformanceUserValues(USER_ID, "run-state"));
        await db.insert(schema.projects).values({
          id: PROJECT_ID,
          userId: USER_ID,
          name: "Run State",
          slug: "run-state",
        });
        for (const [id, title] of [
          [THREAD_A, "Thread A"],
          [THREAD_B, "Thread B"],
        ] as const)
          await db.insert(schema.threads).values({
            rootThreadId: id,
            id,
            projectId: PROJECT_ID,
            createdByUserId: USER_ID,
            title,
          });
      });
      afterAll(() => db.close());
      const records = async (threadId: ThreadId) =>
        (await journalEventsByThread(db, threadId)).filter(
          (row) => row.eventType === "run_state.changed",
        );
      const message = (key: string, threadId = THREAD_A) => ({
        threadId,
        intent: "message" as const,
        provenance: { kind: "writer" as const, actorId: USER_ID },
        body: { kind: "text" as const, text: key },
        idempotencyKey: key,
      });
      it("refuses a mark on a chat whose thread lock the transaction doesn't hold", async () => {
        await expect(
          runInDrizzleTransaction(db, async () => markRunStateChanged(THREAD_A)),
        ).rejects.toThrow("without the thread lock");
      });
      it("counts a lock taken in a released savepoint and forgets one taken in a rolled-back one", async () => {
        await runInDrizzleTransaction(db, async () => {
          await runInDrizzleSavepoint(db, () => lock.withThreadLock(THREAD_A, async () => {}));
          markRunStateChanged(THREAD_A);
          await expect(
            runInDrizzleSavepoint(db, async () => {
              await lock.withThreadLock(THREAD_B, async () => {});
              throw new Error("rolled back");
            }),
          ).rejects.toThrow("rolled back");
          expect(() => markRunStateChanged(THREAD_B)).toThrow("without the thread lock");
        });
        expect(await records(THREAD_A)).toHaveLength(1);
        expect(await records(THREAD_B)).toHaveLength(0);
      });
      it("appends a second, newer record for a write after an early publication", async () => {
        const first = await lock.withThreadLock(THREAD_A, async () => {
          await inbox.enqueue(message("one"));
          const early = await publishRunState(THREAD_A);
          await inbox.enqueue(message("two"));
          return early;
        });
        const rows = await records(THREAD_A);
        expect(rows).toHaveLength(2);
        expect(first.version).toBe(eventSeqForJournalEvent(rows[0]?.seq as bigint, 0).toString());
        expect(
          (
            rows[1]?.payload as {
              runState: {
                items: unknown[];
              };
            }
          ).runState.items,
        ).toHaveLength(2);
        expect(rows[1]?.seq as bigint).toBeGreaterThan(rows[0]?.seq as bigint);
      });
      it("refuses an input write that lands after the flush", async () => {
        await expect(
          lock.withThreadLock(THREAD_A, async () => {
            // Enlisted after the publication participant, so it flushes after it.
            enlistDrizzleTransactionParticipant({
              key: {},
              create: () => ({}),
              fork: () => ({}),
              merge: (_parent, child) => child,
              beforeCommit: async () => markRunStateChanged(THREAD_A),
            });
          }),
        ).rejects.toThrow("after its record was published");
      });
      it("answers inside a savepoint with the record an ancestor's write made, published now", async () => {
        const answer = await lock.withThreadLock(THREAD_A, async () => {
          await inbox.enqueue(message("ancestor"));
          return runInDrizzleSavepoint(db, () => answerRunState(THREAD_A));
        });
        const rows = await records(THREAD_A);
        // Published by the answer itself, not re-read at the old head, and not published twice at commit.
        expect(rows).toHaveLength(1);
        expect(answer.version).toBe(eventSeqForJournalEvent(rows[0]?.seq as bigint, 0).toString());
        expect(answer.items).toHaveLength(1);
      });
    });
  }
});
