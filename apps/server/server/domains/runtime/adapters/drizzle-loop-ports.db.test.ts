/** PostgreSQL coverage for the drizzle Inbox and lease-backed RunAuthority adapters. */

import type { ThreadId } from "@meridian/contracts/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { MessageDraft } from "../loop/ports.js";

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
    const { createDrizzleThreadLock } = await import("./drizzle-thread-lock.js");
    const { closeRun } = await import("../loop/close-run.js");
    const { createDrizzleRunAuthority, createDrizzleThreadRunOwnership } = await import(
      "./drizzle-thread-run-ownership.js"
    );

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

    function steer(key: string, threadId: ThreadId = THREAD_A): MessageDraft {
      return {
        threadId,
        intent: "steer",
        provenance: { kind: "writer", actorId: USER_ID },
        body: { kind: "text", text: key },
        idempotencyKey: key,
      };
    }

    function systemMessage(key: string, threadId: ThreadId = THREAD_A): MessageDraft {
      return {
        threadId,
        intent: "system",
        provenance: { kind: "system", source: "work" },
        body: { kind: "context", parts: [{ source: "work", text: key }] },
        idempotencyKey: key,
      };
    }

    it("claims pending messages in per-thread enqueue order", async () => {
      const inbox = createDrizzleInbox(db);
      await inbox.enqueue(steer("a1", THREAD_A));
      await inbox.enqueue(steer("b1", THREAD_B));
      await inbox.enqueue(steer("a2", THREAD_A));

      const claimed = await inbox.claimPending(THREAD_A);
      expect(claimed.map((message) => message.idempotencyKey)).toEqual(["a1", "a2"]);
      expect(claimed.map((message) => message.provenance.kind)).toEqual(["writer", "writer"]);
      expect(claimed.map((message) => message.body.kind)).toEqual(["text", "text"]);
    });

    it("acks delivered messages and redelivers the unacked", async () => {
      const inbox = createDrizzleInbox(db);
      const first = await inbox.enqueue(steer("a1"));
      await inbox.enqueue(steer("a2"));

      await inbox.ack(THREAD_A, [first.id]);
      const redelivered = await inbox.claimPending(THREAD_A);
      expect(redelivered.map((message) => message.idempotencyKey)).toEqual(["a2"]);
    });

    it("collapses a duplicate enqueue on the idempotency key", async () => {
      const inbox = createDrizzleInbox(db);
      const first = await inbox.enqueue(steer("same-key"));
      const second = await inbox.enqueue(steer("same-key"));

      expect(second.id).toBe(first.id);
      expect(second.seq).toBe(first.seq);
      expect(await inbox.claimPending(THREAD_A)).toHaveLength(1);
    });

    it("keeps the same idempotency key distinct across threads", async () => {
      const inbox = createDrizzleInbox(db);
      const first = await inbox.enqueue(steer("shared-key", THREAD_A));
      const second = await inbox.enqueue(steer("shared-key", THREAD_B));

      expect(second.id).not.toBe(first.id);
      expect(second.threadId).toBe(THREAD_B);
      expect(await inbox.claimPending(THREAD_B)).toHaveLength(1);
    });

    it("lists distinct pending-steer threads oldest first and excludes system messages", async () => {
      const inbox = createDrizzleInbox(db);
      await inbox.enqueue(systemMessage("s1", THREAD_A));
      await inbox.enqueue(steer("a1", THREAD_A));
      await inbox.enqueue(steer("b1", THREAD_B));
      await inbox.enqueue(systemMessage("s2", THREAD_B));

      expect(await inbox.pendingSteerThreads(10)).toEqual([THREAD_A, THREAD_B]);
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

      it("keeps the run alive when a steer commits before the final claim", async () => {
        const inbox = createDrizzleInbox(db);
        const authority = createDrizzleRunAuthority(db, { holderId: "holder-1" });
        const threadLock = createDrizzleThreadLock(db);
        const lease = required(await authority.acquire(THREAD_A, "run-1"));

        const enqueueHeld = deferred<void>();
        const releaseEnqueue = deferred<void>();
        const enqueue = threadLock.withThreadLock(THREAD_A, async () => {
          await inbox.enqueue(steer("in-window"));
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

      it("completes then releases on an empty claim so a later steer finds no live lease", async () => {
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
            complete: async () => "terminal",
          }),
        ).toEqual({ kind: "completed", completion: "terminal" });
        expect(await authority.holder(THREAD_A)).toBeNull();

        await threadLock.withThreadLock(THREAD_A, () => inbox.enqueue(steer("after-release")));
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

      it("serializes enqueue against the final claim so a racing steer is never stranded", async () => {
        const inbox = createDrizzleInbox(db);
        const authority = createDrizzleRunAuthority(db, { holderId: "holder-1" });
        const threadLock = createDrizzleThreadLock(db);

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
              complete: async () => "terminal",
            }),
            threadLock.withThreadLock(THREAD_A, () => inbox.enqueue(steer(`race-${attempt}`))),
          ]);

          const holder = await authority.holder(THREAD_A);
          // The lock makes the two outcomes exhaustive: the run either saw the
          // steer and kept its lease, or released first and the steer is pending
          // for the wake sweep. Never released with the steer already claimed.
          expect(outcome.kind === "continue").toBe(holder !== null);
          expect(await inbox.claimPending(THREAD_A)).toHaveLength(1);
          if (holder !== null) await authority.release(lease);
        }
      });
    });
  });
}
