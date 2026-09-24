/** PostgreSQL coverage for the drizzle Inbox and lease-backed RunAuthority adapters. */

import type { ThreadId } from "@meridian/contracts/runtime";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { MessageDraft } from "../loop/ports.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-0000000008a1";
const PROJECT_ID = "00000000-0000-4000-8000-0000000008a2";
const THREAD_A = "00000000-0000-4000-8000-0000000008a3" as ThreadId;
const THREAD_B = "00000000-0000-4000-8000-0000000008a4" as ThreadId;
const ASSISTANT_TURN = "00000000-0000-4000-8000-0000000008a5";

function required<T>(value: T | null): T {
  if (value === null) throw new Error("expected a value");
  return value;
}

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("loop ports (postgres)", () => {});
} else {
  describe("loop ports (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createDrizzleInbox } = await import("./drizzle-inbox.js");
    const { projectPendingInbox } = await import("../loop/pending-inbox.js");
    const { createDrizzleThreadLock } = await import("./drizzle-thread-lock.js");
    const { closeRun } = await import("../loop/close-run.js");
    const { sweepWakes } = await import("../loop/sweep-wakes.js");
    const { createThreadedInbox } = await import("../loop/threaded-inbox.js");
    const { createInMemoryRunStarter } = await import("./in-memory/loop-ports.js");
    const { createDrizzleRunAuthority, createDrizzleThreadRunOwnership } = await import(
      "./drizzle-thread-run-ownership.js"
    );
    const { runInDrizzleTransaction } = await import("../../../shared/drizzle-transaction.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 6 });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "loop-ports"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Loop Ports",
        slug: "loop-ports",
      });
      await db.insert(schema.threads).values({
        id: THREAD_A,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Thread A",
      });
      await db.insert(schema.threads).values({
        id: THREAD_B,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Thread B",
      });
    });

    afterAll(async () => {
      await db.close();
    });

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

    it("claims pending messages in per-thread enqueue order", async () => {
      const inbox = createDrizzleInbox(db);
      await inbox.enqueue(message("a1", THREAD_A));
      await inbox.enqueue(message("b1", THREAD_B));
      await inbox.enqueue(message("a2", THREAD_A));

      const claimed = await inbox.claimPending(THREAD_A);
      expect(claimed.map((message) => message.idempotencyKey)).toEqual(["a1", "a2"]);
      expect(claimed.map((message) => message.provenance.kind)).toEqual(["writer", "writer"]);
      expect(claimed.map((message) => message.body.kind)).toEqual(["text", "text"]);
    });

    it("acks delivered messages and redelivers the unacked", async () => {
      const inbox = createDrizzleInbox(db);
      const first = await inbox.enqueue(message("a1"));
      await inbox.enqueue(message("a2"));

      await inbox.ack(THREAD_A, [first.id]);
      const redelivered = await inbox.claimPending(THREAD_A);
      expect(redelivered.map((message) => message.idempotencyKey)).toEqual(["a2"]);
    });

    it("collapses a duplicate enqueue on the idempotency key", async () => {
      const inbox = createDrizzleInbox(db);
      const first = await inbox.enqueue(message("same-key"));
      const second = await inbox.enqueue(message("same-key"));

      expect(second.id).toBe(first.id);
      expect(second.seq).toBe(first.seq);
      expect(await inbox.claimPending(THREAD_A)).toHaveLength(1);
    });

    it("keeps the same idempotency key distinct across threads", async () => {
      const inbox = createDrizzleInbox(db);
      const first = await inbox.enqueue(message("shared-key", THREAD_A));
      const second = await inbox.enqueue(message("shared-key", THREAD_B));

      expect(second.id).not.toBe(first.id);
      expect(second.threadId).toBe(THREAD_B);
      expect(await inbox.claimPending(THREAD_B)).toHaveLength(1);
    });

    it("lists pending rows read-only, excluding delivered and ordered by seq", async () => {
      const inbox = createDrizzleInbox(db);
      const first = await inbox.enqueue(message("a1", THREAD_A));
      await inbox.enqueue(message("b1", THREAD_B));
      const second = await inbox.enqueue(notice("a2", THREAD_A));
      const third = await inbox.enqueue(message("a3", THREAD_A));

      const pending = await inbox.listPending(THREAD_A);
      expect(pending.map((row) => row.idempotencyKey)).toEqual(["a1", "a2", "a3"]);
      expect(pending.map((row) => row.seq)).toEqual([first.seq, second.seq, third.seq]);
      // The read has no claim side effect: the rows stay claimable.
      expect(await inbox.claimPending(THREAD_A)).toHaveLength(3);

      await inbox.ack(THREAD_A, [first.id]);
      const afterAck = await inbox.listPending(THREAD_A);
      expect(afterAck.map((row) => row.idempotencyKey)).toEqual(["a2", "a3"]);
      expect(afterAck.map((row) => row.seq)).toEqual([second.seq, third.seq]);
    });

    it("lists distinct pending-message threads oldest first and excludes notices", async () => {
      const inbox = createDrizzleInbox(db);
      await inbox.enqueue(notice("s1", THREAD_A));
      await inbox.enqueue(message("a1", THREAD_A));
      await inbox.enqueue(message("b1", THREAD_B));
      await inbox.enqueue(notice("s2", THREAD_B));

      expect(await inbox.pendingMessageThreads(10)).toEqual([THREAD_A, THREAD_B]);
    });

    it("wakes a pending-message thread and skips one with a live lease", async () => {
      const inbox = createDrizzleInbox(db);
      const authority = createDrizzleRunAuthority(db, { holderId: "holder-sweep" });
      await inbox.enqueue(message("sweep-a", THREAD_A));
      await inbox.enqueue(message("sweep-b", THREAD_B));
      const leaseA = required(await authority.acquire(THREAD_A, "run-a"));

      const started: ThreadId[] = [];
      await sweepWakes({
        inbox,
        authority,
        runStarter: {
          async start(threadId) {
            started.push(threadId);
          },
        },
        limit: 10,
      });

      expect(started).toEqual([THREAD_B]);
      await authority.release(leaseA);
    });

    it("gives a single winner on acquire and reflects the live lease in holder/read", async () => {
      const first = createDrizzleRunAuthority(db, { holderId: "holder-1" });
      const second = createDrizzleRunAuthority(db, { holderId: "holder-2" });

      const lease = required(await first.acquire(THREAD_A, "run-1"));
      expect(await second.acquire(THREAD_A, "run-2")).toBeNull();
      expect(await first.holder(THREAD_A)).toBe("run-1");
      expect(await first.read(THREAD_A)).toEqual({
        kind: "awake",
        phase: "generating",
        cancelRequested: false,
      });

      await first.publish(lease, "waiting");
      expect(await first.read(THREAD_A)).toEqual({
        kind: "awake",
        phase: "waiting",
        cancelRequested: false,
      });

      await first.release(lease);
      expect(await first.holder(THREAD_A)).toBeNull();
      expect(await first.read(THREAD_A)).toEqual({ kind: "asleep" });

      const secondLease = required(await second.acquire(THREAD_A, "run-3"));
      await second.release(secondLease);
    });

    it("binds release to its run so a superseded release keeps the newer lock", async () => {
      const first = createDrizzleRunAuthority(db, { holderId: "holder-1" });
      const second = createDrizzleRunAuthority(db, { holderId: "holder-2" });

      const runOne = required(await first.acquire(THREAD_A, "run-1"));
      await first.release(runOne);

      const runTwo = required(await first.acquire(THREAD_A, "run-2"));
      await first.release(runOne);
      await first.release(runOne);

      expect(await first.holder(THREAD_A)).toBe("run-2");
      expect(await first.read(THREAD_A)).toEqual({
        kind: "awake",
        phase: "generating",
        cancelRequested: false,
      });
      expect(await second.acquire(THREAD_A, "run-3")).toBeNull();

      await first.release(runTwo);
      expect(await first.holder(THREAD_A)).toBeNull();
      const runThree = required(await second.acquire(THREAD_A, "run-3"));
      await second.release(runThree);
    });

    it("keeps the physical claim and lease when terminal release rolls back", async () => {
      const first = createDrizzleRunAuthority(db, { holderId: "holder-1" });
      const second = createDrizzleRunAuthority(db, { holderId: "holder-2" });
      const lease = required(await first.acquire(THREAD_A, "run-1"));

      await expect(
        runInDrizzleTransaction(db, async () => {
          await first.release(lease);
          throw new Error("terminal rollback");
        }),
      ).rejects.toThrow("terminal rollback");

      expect(await first.holder(THREAD_A)).toBe("run-1");
      expect(await second.acquire(THREAD_A, "run-2")).toBeNull();
      await first.release(lease);
      const next = required(await second.acquire(THREAD_A, "run-2"));
      await second.release(next);
    });

    it("keeps the physical claim until the terminal transaction commits", async () => {
      const first = createDrizzleRunAuthority(db, { holderId: "holder-1" });
      const second = createDrizzleRunAuthority(db, { holderId: "holder-2" });
      const lease = required(await first.acquire(THREAD_A, "run-1"));
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
      expect(await second.acquire(THREAD_A, "run-2")).toBeNull();
      releaseTransaction();
      await completion;
      const next = required(await second.acquire(THREAD_A, "run-2"));
      await second.release(next);
    });

    it("observes the cancel flag through read and keeps cancel idempotent", async () => {
      const authority = createDrizzleRunAuthority(db, { holderId: "holder-1" });
      const lease = required(await authority.acquire(THREAD_A, "run-1"));

      await authority.cancel(THREAD_A);
      await authority.cancel(THREAD_A);
      expect(await authority.read(THREAD_A)).toEqual({
        kind: "awake",
        phase: "generating",
        cancelRequested: true,
      });
      await authority.release(lease);
    });

    it("reports whether renew kept ownership", async () => {
      const authority = createDrizzleRunAuthority(db, { holderId: "holder-1" });

      const lease = required(await authority.acquire(THREAD_A, "run-1"));
      expect(await authority.renew(lease)).toBe(true);

      await authority.release(lease);
      expect(await authority.renew(lease)).toBe(false);
    });

    it("reports an expired lease as asleep", async () => {
      const authority = createDrizzleRunAuthority(db, { holderId: "holder-1", leaseTtlMs: 0 });
      const lease = required(await authority.acquire(THREAD_A, "run-1"));
      expect(await authority.holder(THREAD_A)).toBeNull();
      expect(await authority.read(THREAD_A)).toEqual({ kind: "asleep" });
      await authority.release(lease);
    });

    it("keeps the lease and the legacy claim mutually exclusive on one thread", async () => {
      const authority = createDrizzleRunAuthority(db, { holderId: "holder-lease" });
      const legacy = createDrizzleThreadRunOwnership(db);

      const lease = required(await authority.acquire(THREAD_A, "run-lease"));
      expect(await legacy.tryAcquire(THREAD_A)).toBeNull();
      await authority.release(lease);
      expect(await authority.holder(THREAD_A)).toBeNull();

      const claim = required(await legacy.tryAcquire(THREAD_A));
      expect(await authority.acquire(THREAD_A, "run-after")).toBeNull();
      await claim.release();

      const relocked = required(await authority.acquire(THREAD_A, "run-final"));
      await authority.release(relocked);
    });

    describe("closeRun final claim", () => {
      function deferred<T>() {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((r) => {
          resolve = r;
        });
        return { promise, resolve };
      }

      async function clearInbox() {
        await db.delete(schema.threadInboxMessages);
      }

      it("keeps the run alive when a message commits before the final claim", async () => {
        const inbox = createDrizzleInbox(db);
        const authority = createDrizzleRunAuthority(db, { holderId: "holder-1" });
        const threadLock = createDrizzleThreadLock(db);
        const lease = required(await authority.acquire(THREAD_A, "run-1"));

        const enqueueHeld = deferred<void>();
        const releaseEnqueue = deferred<void>();
        const enqueue = threadLock.withThreadLock(THREAD_A, async () => {
          await inbox.enqueue(message("in-window"));
          enqueueHeld.resolve();
          await releaseEnqueue.promise;
        });
        await enqueueHeld.promise;

        let completed = false;
        const closing = closeRun({
          threadLock,
          inbox,
          runAuthority: authority,
          threadId: THREAD_A,
          lease,
          continueOnPending: true,
          complete: async () => {
            completed = true;
            return "terminal";
          },
        });
        releaseEnqueue.resolve();
        await enqueue;

        expect(await closing).toMatchObject({ kind: "continue" });
        expect(completed).toBe(false);
        expect(await authority.holder(THREAD_A)).toBe("run-1");
        expect((await inbox.claimPending(THREAD_A)).map((m) => m.idempotencyKey)).toEqual([
          "in-window",
        ]);
        await authority.release(lease);
      });

      it("completes then releases on an empty claim so a later message finds no live lease", async () => {
        const inbox = createDrizzleInbox(db);
        const authority = createDrizzleRunAuthority(db, { holderId: "holder-1" });
        const threadLock = createDrizzleThreadLock(db);
        const lease = required(await authority.acquire(THREAD_A, "run-1"));

        expect(
          await closeRun({
            threadLock,
            inbox,
            runAuthority: authority,
            threadId: THREAD_A,
            lease,
            continueOnPending: true,
            complete: async () => "terminal",
          }),
        ).toEqual({ kind: "completed", completion: "terminal" });
        expect(await authority.holder(THREAD_A)).toBeNull();

        await threadLock.withThreadLock(THREAD_A, () => inbox.enqueue(message("after-release")));
        expect(await authority.holder(THREAD_A)).toBeNull();
        expect((await inbox.claimPending(THREAD_A)).map((m) => m.idempotencyKey)).toEqual([
          "after-release",
        ]);
      });

      it("holds the lease across the terminal completion so no second acquire can interleave", async () => {
        const inbox = createDrizzleInbox(db);
        const authority = createDrizzleRunAuthority(db, { holderId: "holder-1" });
        const second = createDrizzleRunAuthority(db, { holderId: "holder-2" });
        const threadLock = createDrizzleThreadLock(db);
        const lease = required(await authority.acquire(THREAD_A, "run-1"));

        const completeEntered = deferred<void>();
        const allowComplete = deferred<void>();
        const closing = closeRun({
          threadLock,
          inbox,
          runAuthority: authority,
          threadId: THREAD_A,
          lease,
          continueOnPending: true,
          complete: async () => {
            completeEntered.resolve();
            await allowComplete.promise;
            return "terminal";
          },
        });

        await completeEntered.promise;
        // The terminal write is in flight; the lease must still block a new run.
        expect(await second.acquire(THREAD_A, "run-2")).toBeNull();
        expect(await authority.holder(THREAD_A)).toBe("run-1");

        allowComplete.resolve();
        expect(await closing).toEqual({ kind: "completed", completion: "terminal" });
        expect(await authority.holder(THREAD_A)).toBeNull();
        const runTwo = required(await second.acquire(THREAD_A, "run-2"));
        await second.release(runTwo);
      });

      it("serializes the producer enqueue against the final claim so a racing message is never stranded", async () => {
        const inbox = createDrizzleInbox(db);
        const authority = createDrizzleRunAuthority(db, { holderId: "holder-1" });
        const threadLock = createDrizzleThreadLock(db);
        const threadedInbox = createThreadedInbox({
          inbox,
          threadLock,
          runStarter: createInMemoryRunStarter(),
          schedulePostCommit: (task) => task(),
        });

        for (let attempt = 0; attempt < 24; attempt++) {
          await clearInbox();
          const lease = required(await authority.acquire(THREAD_A, `run-${attempt}`));
          const [outcome] = await Promise.all([
            closeRun({
              threadLock,
              inbox,
              runAuthority: authority,
              threadId: THREAD_A,
              lease,
              continueOnPending: true,
              complete: async () => "terminal",
            }),
            threadedInbox.enqueue(message(`race-${attempt}`)),
          ]);

          const holder = await authority.holder(THREAD_A);
          // The lock makes the two outcomes exhaustive: the run either saw the
          // message and kept its lease, or released first and the message is pending
          // for the wake sweep. Never released with the message already claimed.
          expect(outcome.kind === "continue").toBe(holder !== null);
          expect(await inbox.claimPending(THREAD_A)).toHaveLength(1);
          if (holder !== null) await authority.release(lease);
        }
      });

      it("commits an inbox ack only with the transaction that carries it", async () => {
        const inbox = createDrizzleInbox(db);
        const { createDrizzleRepositoriesForTest } = await import(
          "../../threads/adapters/drizzle/index.js"
        );
        const repos = createDrizzleRepositoriesForTest(db);
        const inboxMessage = await inbox.enqueue(message("ack-with-response"));

        await expect(
          repos.transaction(async () => {
            await inbox.ack(THREAD_A, [inboxMessage.id]);
            throw new Error("response persist failed");
          }),
        ).rejects.toThrow("response persist failed");
        // The ack rolled back with the transaction that failed.
        expect((await inbox.claimPending(THREAD_A)).map((m) => m.idempotencyKey)).toEqual([
          "ack-with-response",
        ]);

        await repos.transaction(async () => {
          await inbox.ack(THREAD_A, [inboxMessage.id]);
        });
        expect(await inbox.claimPending(THREAD_A)).toEqual([]);
      });

      it("projects exact live-run adoption before ack and invalidates it on release", async () => {
        const inbox = createDrizzleInbox(db);
        await db.insert(schema.turns).values({
          id: ASSISTANT_TURN,
          threadId: THREAD_A,
          role: "assistant",
          status: "streaming",
          metadata: { retained: "value" },
        });
        const f = await inbox.enqueue(message("F"));
        const g = await inbox.enqueue(message("G"));
        const authority = createDrizzleRunAuthority(db, { holderId: "holder-adoption" });
        const lease = required(await authority.acquire(THREAD_A, "run-adoption"));

        await authority.bindTurn(lease, ASSISTANT_TURN, [f.id]);
        let projection = await inbox.readPendingProjection(THREAD_A);
        expect(
          projectPendingInbox(projection.messages, projection.run).items.map((item) => [
            item.id,
            item.deliveryState,
          ]),
        ).toEqual([
          [f.id, "consuming"],
          [g.id, "waiting"],
        ]);
        expect(projection.messages.every((message) => message.deliveredAt === null)).toBe(true);

        await authority.setInboxConsumption(lease, [g.id]);
        projection = await inbox.readPendingProjection(THREAD_A);
        expect(
          projectPendingInbox(projection.messages, projection.run).items.map((item) => [
            item.id,
            item.deliveryState,
          ]),
        ).toEqual([
          [f.id, "waiting"],
          [g.id, "consuming"],
        ]);
        expect(
          (await db.select().from(schema.turns).where(eq(schema.turns.id, ASSISTANT_TURN)))[0]
            .metadata,
        ).toMatchObject({ retained: "value", inboxConsumption: { messageIds: [g.id] } });

        await authority.release(lease);
        projection = await inbox.readPendingProjection(THREAD_A);
        expect(
          projectPendingInbox(projection.messages, projection.run).items.map(
            (item) => item.deliveryState,
          ),
        ).toEqual(["awaiting_run", "awaiting_run"]);
      });

      it("reads staged bind and ack state from the publishing transaction and rolls it back", async () => {
        const inbox = createDrizzleInbox(db);
        const { createDrizzleRepositoriesForTest } = await import(
          "../../threads/adapters/drizzle/index.js"
        );
        const repos = createDrizzleRepositoriesForTest(db);
        await db.insert(schema.turns).values({
          id: ASSISTANT_TURN,
          threadId: THREAD_A,
          role: "assistant",
          status: "streaming",
        });
        const f = await inbox.enqueue(message("transactional-F"));
        const authority = createDrizzleRunAuthority(db, { holderId: "holder-staged" });
        const lease = required(await authority.acquire(THREAD_A, "run-staged"));

        await expect(
          repos.transaction(async () => {
            await authority.bindTurn(lease, ASSISTANT_TURN, [f.id]);
            const adopted = await inbox.readPendingProjection(THREAD_A);
            expect(projectPendingInbox(adopted.messages, adopted.run).items[0]?.deliveryState).toBe(
              "consuming",
            );
            await inbox.ack(THREAD_A, [f.id]);
            expect((await inbox.readPendingProjection(THREAD_A)).messages).toEqual([]);
            throw new Error("response transaction failed");
          }),
        ).rejects.toThrow("response transaction failed");

        const rolledBack = await inbox.readPendingProjection(THREAD_A);
        expect(rolledBack.messages.map((item) => item.id)).toEqual([f.id]);
        expect(rolledBack.run).toMatchObject({ turnId: null, messageIds: [] });
        await authority.release(lease);
      });
    });
  });
}
