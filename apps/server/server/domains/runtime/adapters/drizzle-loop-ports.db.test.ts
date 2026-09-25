import { eq } from "drizzle-orm";
import { createInMemoryEventSink } from "../../observability/index.js";
/** PostgreSQL coverage for the drizzle DeliveryStore and lease-backed RunClaim adapters. */

import type { ThreadId } from "@meridian/contracts/runtime";
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
    const { sweepWakes } = await import("../loop/sweep-wakes.js");
    const { createTestDrizzleDelivery } = await import(
      "../loop/__tests__/test-drizzle-delivery.js"
    );
    const { createDrizzleRunClaim } = await import("./drizzle-run-claim.js");
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

    it("constrains inbox JSON kinds without duplicate discriminator columns", async () => {
      const valid = {
        threadId: THREAD_A,
        intent: "notice",
        provenance: { kind: "system", source: "schema-probe" },
        body: { kind: "text", text: "valid" },
        idempotencyKey: "schema-valid",
      };
      await db.insert(schema.threadInboxMessages).values(valid);
      for (const field of ["provenance", "body"] as const) {
        for (const invalid of [{}, { kind: null }, { kind: "unknown" }, null, []]) {
          await expect(
            db.insert(schema.threadInboxMessages).values({
              ...valid,
              idempotencyKey: crypto.randomUUID(),
              [field]: invalid,
            }),
          ).rejects.toThrow();
        }
      }
    });

    it("claims pending messages in per-thread enqueue order", async () => {
      const inbox = createDrizzleInbox(db);
      await inbox.enqueue(message("a1", THREAD_A));
      await inbox.enqueue(message("b1", THREAD_B));
      await inbox.enqueue(message("a2", THREAD_A));

      const claimed = await inbox.selectPending(THREAD_A);
      expect(claimed.map((message) => message.idempotencyKey)).toEqual(["a1", "a2"]);
      expect(claimed.map((message) => message.provenance.kind)).toEqual(["writer", "writer"]);
      expect(claimed.map((message) => message.body.kind)).toEqual(["text", "text"]);
    });

    it("acks delivered messages and redelivers the unacked", async () => {
      const inbox = createDrizzleInbox(db);
      const first = await inbox.enqueue(message("a1"));
      await inbox.enqueue(message("a2"));

      await inbox.ack(THREAD_A, [first.id]);
      const redelivered = await inbox.selectPending(THREAD_A);
      expect(redelivered.map((message) => message.idempotencyKey)).toEqual(["a2"]);
    });

    it("collapses a duplicate enqueue on the idempotency key", async () => {
      const inbox = createDrizzleInbox(db);
      const first = await inbox.enqueue(message("same-key"));
      const second = await inbox.enqueue(message("same-key"));

      expect(second.id).toBe(first.id);
      expect(second.seq).toBe(first.seq);
      expect(await inbox.selectPending(THREAD_A)).toHaveLength(1);
    });

    it("keeps the same idempotency key distinct across threads", async () => {
      const inbox = createDrizzleInbox(db);
      const first = await inbox.enqueue(message("shared-key", THREAD_A));
      const second = await inbox.enqueue(message("shared-key", THREAD_B));

      expect(second.id).not.toBe(first.id);
      expect(second.threadId).toBe(THREAD_B);
      expect(await inbox.selectPending(THREAD_B)).toHaveLength(1);
    });

    it("lists pending rows read-only, excluding delivered and ordered by seq", async () => {
      const inbox = createDrizzleInbox(db);
      const first = await inbox.enqueue(message("a1", THREAD_A));
      await inbox.enqueue(message("b1", THREAD_B));
      const second = await inbox.enqueue(notice("a2", THREAD_A));
      const third = await inbox.enqueue(message("a3", THREAD_A));

      const pending = await inbox.selectPending(THREAD_A);
      expect(pending.map((row) => row.idempotencyKey)).toEqual(["a1", "a2", "a3"]);
      expect(pending.map((row) => row.seq)).toEqual([first.seq, second.seq, third.seq]);
      // The read has no claim side effect: the rows stay claimable.
      expect(await inbox.selectPending(THREAD_A)).toHaveLength(3);

      await inbox.ack(THREAD_A, [first.id]);
      const afterAck = await inbox.selectPending(THREAD_A);
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
      expect(await inbox.pendingMessageThreads(1, THREAD_A)).toEqual([THREAD_B]);
      expect(await inbox.pendingMessageThreads(1, THREAD_B)).toEqual([]);
    });

    it("pages past a poisoned wake candidate and wraps to retry it", async () => {
      const inbox = createDrizzleInbox(db);
      const authority = createDrizzleRunClaim(db);
      await inbox.enqueue(message("poison", THREAD_A));
      await inbox.enqueue(message("later", THREAD_B));
      const started: ThreadId[] = [];
      let afterThreadId: ThreadId | undefined;
      for (let pass = 0; pass < 3; pass++) {
        ({ cursor: afterThreadId } = await sweepWakes({
          delivery: { ...inbox, async refreshPending() {} },
          authority,
          eventSink: createInMemoryEventSink(),
          limit: 1,
          afterThreadId,
          runStarter: {
            async start(threadId) {
              started.push(threadId);
              if (threadId === THREAD_A) throw new Error("exhausted balance");
            },
          },
        }));
      }
      expect(started).toEqual([THREAD_A, THREAD_B, THREAD_A]);
      expect(await inbox.selectPending(THREAD_A)).toHaveLength(1);
    });

    it("wakes a pending-message thread and skips one with a live lease", async () => {
      const inbox = createDrizzleInbox(db);
      const authority = createDrizzleRunClaim(db, { holderId: "holder-sweep" });
      await inbox.enqueue(message("sweep-a", THREAD_A));
      await inbox.enqueue(message("sweep-b", THREAD_B));
      const leaseA = required(await authority.startExecution(THREAD_A, "run-a"));

      const started: ThreadId[] = [];
      await sweepWakes({
        eventSink: createInMemoryEventSink(),
        delivery: { ...inbox, async refreshPending() {} },
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
      const first = createDrizzleRunClaim(db, { holderId: "holder-1" });
      const second = createDrizzleRunClaim(db, { holderId: "holder-2" });

      const lease = required(await first.startExecution(THREAD_A, "run-1"));
      expect(await second.startExecution(THREAD_A, "run-2")).toBeNull();
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

      const secondLease = required(await second.startExecution(THREAD_A, "run-3"));
      await second.release(secondLease);
    });

    it("binds release to its run so a superseded release keeps the newer lock", async () => {
      const first = createDrizzleRunClaim(db, { holderId: "holder-1" });
      const second = createDrizzleRunClaim(db, { holderId: "holder-2" });

      const runOne = required(await first.startExecution(THREAD_A, "run-1"));
      await first.release(runOne);

      const runTwo = required(await first.startExecution(THREAD_A, "run-2"));
      await first.release(runOne);
      await first.release(runOne);

      expect(await first.holder(THREAD_A)).toBe("run-2");
      expect(await first.read(THREAD_A)).toEqual({
        kind: "awake",
        phase: "generating",
        cancelRequested: false,
      });
      expect(await second.startExecution(THREAD_A, "run-3")).toBeNull();

      await first.release(runTwo);
      expect(await first.holder(THREAD_A)).toBeNull();
      const runThree = required(await second.startExecution(THREAD_A, "run-3"));
      await second.release(runThree);
    });

    it("keeps the physical claim and lease when terminal release rolls back", async () => {
      const first = createDrizzleRunClaim(db, { holderId: "holder-1" });
      const second = createDrizzleRunClaim(db, { holderId: "holder-2" });
      const lease = required(await first.startExecution(THREAD_A, "run-1"));

      await expect(
        runInDrizzleTransaction(db, async () => {
          await first.release(lease);
          throw new Error("terminal rollback");
        }),
      ).rejects.toThrow("terminal rollback");

      expect(await first.holder(THREAD_A)).toBe("run-1");
      expect(await second.startExecution(THREAD_A, "run-2")).toBeNull();
      await first.release(lease);
      const next = required(await second.startExecution(THREAD_A, "run-2"));
      await second.release(next);
    });

    it("keeps the physical claim until the terminal transaction commits", async () => {
      const first = createDrizzleRunClaim(db, { holderId: "holder-1" });
      const second = createDrizzleRunClaim(db, { holderId: "holder-2" });
      const lease = required(await first.startExecution(THREAD_A, "run-1"));
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
      expect(await second.startExecution(THREAD_A, "run-2")).toBeNull();
      releaseTransaction();
      await completion;
      const next = required(await second.startExecution(THREAD_A, "run-2"));
      await second.release(next);
    });

    it("observes the cancel flag through read and keeps cancel idempotent", async () => {
      const authority = createDrizzleRunClaim(db, { holderId: "holder-1" });
      const lease = required(await authority.startExecution(THREAD_A, "run-1"));

      await db.insert(schema.turns).values({
        id: ASSISTANT_TURN,
        threadId: THREAD_A,
        role: "assistant",
        status: "streaming",
      });
      await createTestDrizzleDelivery(db, { runClaim: authority }).adoptBatch(lease, async () => ({
        value: undefined,
        turnId: ASSISTANT_TURN,
        messageIds: [],
      }));
      expect(await authority.cancelExecution(THREAD_A, crypto.randomUUID())).toBe(false);
      expect(await authority.read(THREAD_A)).toMatchObject({ cancelRequested: false });
      expect(await authority.cancelExecution(THREAD_A, ASSISTANT_TURN)).toBe(true);
      expect(await authority.cancelExecution(THREAD_A, ASSISTANT_TURN)).toBe(true);
      expect(await authority.read(THREAD_A)).toEqual({
        kind: "awake",
        phase: "generating",
        cancelRequested: true,
      });
      await authority.release(lease);
    });

    it("reports whether renew kept ownership", async () => {
      const authority = createDrizzleRunClaim(db, { holderId: "holder-1" });

      const lease = required(await authority.startExecution(THREAD_A, "run-1"));
      expect(await authority.renew(lease)).toBe(true);

      await authority.release(lease);
      expect(await authority.renew(lease)).toBe(false);
    });

    it("reports an expired lease as asleep", async () => {
      const authority = createDrizzleRunClaim(db, { holderId: "holder-1", leaseTtlMs: 0 });
      const lease = required(await authority.startExecution(THREAD_A, "run-1"));
      expect(await authority.holder(THREAD_A)).toBeNull();
      expect(await authority.read(THREAD_A)).toEqual({ kind: "asleep" });
      await authority.release(lease);
    });

    it("excludes short claims and executions locally and across adapters without fake leases", async () => {
      const claim = createDrizzleRunClaim(db);
      const remote = createDrizzleRunClaim(db);
      await claim.withExclusiveThread(THREAD_A, async () => {
        expect(await claim.read(THREAD_A)).toEqual({ kind: "asleep" });
        expect(await claim.withExclusiveThread(THREAD_A, async () => true)).toBeNull();
        expect(await claim.startExecution(THREAD_A, "local")).toBeNull();
        expect(await remote.withExclusiveThread(THREAD_A, async () => true)).toBeNull();
        expect(await remote.startExecution(THREAD_A, "remote")).toBeNull();
        expect(await claim.withExclusiveThread(THREAD_B, async () => true)).toBe(true);
      });
      const lease = required(await claim.startExecution(THREAD_A, "live"));
      expect(await claim.withExclusiveThread(THREAD_A, async () => true)).toBeNull();
      expect(await remote.withExclusiveThread(THREAD_A, async () => true)).toBeNull();
      await claim.release(lease);
      expect(await remote.withExclusiveThread(THREAD_A, async () => true)).toBe(true);
    });

    describe("RuntimeDelivery atomic transitions", () => {
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
            status: "streaming",
          }),
        };
      }
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
        expect(visible).toEqual([
          [1, 1],
          [1, 2],
        ]);
      });
      it("rolls back initial adoption, response+ack and terminal+release on projection failure", async () => {
        const { currentDrizzleDb } = await import("../../../shared/drizzle-transaction.js");
        const { repos, turn } = await assistant();
        const runClaim = createDrizzleRunClaim(db);
        const remote = createDrizzleRunClaim(db);
        const lease = required(await runClaim.startExecution(THREAD_A, "atomic"));
        const delivery = createTestDrizzleDelivery(db, { repos, runClaim });
        const failing = createTestDrizzleDelivery(db, { repos, runClaim, eventWriter: failure });
        const row = await delivery.enqueue(message("batch"));
        const prepare = async () => ({ value: undefined, turnId: turn.id, messageIds: [row.id] });
        await expect(failing.adoptBatch(lease, prepare)).rejects.toThrow("projection unavailable");
        expect(await runClaim.readRunningTurnId(THREAD_A)).toBeNull();
        await delivery.adoptBatch(lease, prepare);
        const response = () =>
          currentDrizzleDb(db)
            .update(schema.turns)
            .set({ responseCount: 1 })
            .where(eq(schema.turns.id, turn.id));
        await expect(failing.ackWithResponse(lease, [row.id], response)).rejects.toThrow(
          "projection unavailable",
        );
        expect((await repos.turns.findById(turn.id))?.responseCount).toBe(0);
        expect((await delivery.readPendingProjection(THREAD_A)).run?.messageIds).toEqual([row.id]);
        expect(await delivery.selectPending(THREAD_A)).toHaveLength(1);
        await delivery.ackWithResponse(lease, [row.id], response);
        expect(await delivery.selectPending(THREAD_A)).toHaveLength(0);
        const terminal = {
          lease,
          assistantTurnId: turn.id,
          cause: { kind: "success" as const, finishReason: "end_turn" as const },
        };
        await expect(failing.close(terminal)).rejects.toThrow("projection unavailable");
        expect((await repos.turns.findById(turn.id))?.status).toBe("streaming");
        expect(await runClaim.readRunningTurnId(THREAD_A)).toBe(turn.id);
        expect(await remote.startExecution(THREAD_A, "blocked")).toBeNull();
        expect((await delivery.close(terminal)).kind).toBe("completed");
        expect(await remote.withExclusiveThread(THREAD_A, async () => true)).toBe(true);
      });
      it("refreshes expired queue state even when the recovery wake fails", async () => {
        const { repos, turn } = await assistant();
        const runClaim = createDrizzleRunClaim(db);
        const lease = required(await runClaim.startExecution(THREAD_A, "expired"));
        const delivery = createTestDrizzleDelivery(db, { repos, runClaim });
        try {
          await delivery.adoptBatch(lease, async () => ({
            value: undefined,
            turnId: turn.id,
            messageIds: [],
          }));
          await delivery.enqueue(message("waiting"));
          await db
            .update(schema.threadRunLeases)
            .set({ expiresAt: new Date(0) })
            .where(eq(schema.threadRunLeases.threadId, THREAD_A));
          await sweepWakes({
            delivery,
            authority: runClaim,
            eventSink: createInMemoryEventSink(),
            limit: 10,
            runStarter: {
              async start() {
                throw new Error("credits exhausted");
              },
            },
          });
          const events = await db
            .select()
            .from(schema.eventJournal)
            .where(eq(schema.eventJournal.threadId, THREAD_A));
          expect(events.at(-1)?.payload).toMatchObject({
            type: "inbox.changed",
            pending: { items: [{ deliveryState: "awaiting_run" }] },
          });
        } finally {
          await runClaim.release(lease);
        }
      });
      it.each([
        "mismatch",
        "expiry",
      ])("keeps response ack tied to the held receipt (%s)", async (variant) => {
        const { repos, turn } = await assistant();
        const runClaim = createDrizzleRunClaim(db);
        const lease = required(await runClaim.startExecution(THREAD_A, "receipt"));
        const delivery = createTestDrizzleDelivery(db, { repos, runClaim });
        try {
          const row = await delivery.enqueue(message("receipt"));
          await delivery.adoptBatch(lease, async () => ({
            value: undefined,
            turnId: turn.id,
            messageIds: [row.id],
          }));
          if (variant === "mismatch") {
            await expect(
              delivery.ackWithResponse(lease, [crypto.randomUUID()], async () => "response"),
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
              delivery.ackWithResponse(lease, [row.id], async () => "paid response"),
            ).resolves.toBe("paid response");
            expect(await delivery.selectPending(THREAD_A)).toHaveLength(0);
          }
        } finally {
          await runClaim.release(lease);
        }
      });
      it.each([
        false,
        true,
      ])("honors a remote cancel before terminal close (pending followup: %s)", async (hasPending) => {
        const { repos, turn } = await assistant();
        const runClaim = createDrizzleRunClaim(db);
        const remote = createDrizzleRunClaim(db);
        const lease = required(await runClaim.startExecution(THREAD_A, "remote-cancel"));
        const delivery = createTestDrizzleDelivery(db, { repos, runClaim });
        try {
          await delivery.adoptBatch(lease, async () => ({
            value: undefined,
            turnId: turn.id,
            messageIds: [],
          }));
          const pending = hasPending ? await delivery.enqueue(message("next-run")) : null;
          expect(await remote.cancelExecution(THREAD_A, turn.id)).toBe(true);
          const closed = await delivery.close({
            lease,
            assistantTurnId: turn.id,
            cause: { kind: "success", finishReason: "end_turn" },
            continueWith: {
              lease,
              currentTurn: turn,
              knownTurnIds: new Set([turn.id]),
              expectedLeafTurnId: turn.id,
            },
          });
          expect(closed.kind).toBe("completed");
          expect((await repos.turns.findById(turn.id))?.status).toBe("cancelled");
          expect((await delivery.selectPending(THREAD_A)).map((row) => row.id)).toEqual(
            pending ? [pending.id] : [],
          );
        } finally {
          await runClaim.release(lease);
        }
      });
      it("serializes a racing enqueue after terminal commit and leaves it recoverable", async () => {
        const { repos, turn } = await assistant();
        const { createDrizzleEventJournalWriter } = await import("../../threads/index.js");
        const writer = createDrizzleEventJournalWriter(db);
        const runClaim = createDrizzleRunClaim(db);
        const lease = required(await runClaim.startExecution(THREAD_A, "race"));
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
          turnId: turn.id,
          messageIds: [],
        }));
        const closing = createTestDrizzleDelivery(db, {
          repos,
          runClaim,
          eventWriter: {
            async appendEvent(threadId, event) {
              if (event.type === "inbox.changed") {
                entered();
                await gate;
              }
              return writer.appendEvent(threadId, event);
            },
          },
        }).close({
          lease,
          assistantTurnId: turn.id,
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
