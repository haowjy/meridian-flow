/** Unit coverage for the in-memory loop ports: inbox ordering/ack and run authority leases. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import type { MessageDraft } from "../../loop/ports.js";
import {
  createInMemoryInbox,
  createInMemoryRunAuthority,
  createInMemoryRunStarter,
} from "./loop-ports.js";

const THREAD_A = "00000000-0000-4000-8000-0000000000a1" as ThreadId;
const THREAD_B = "00000000-0000-4000-8000-0000000000b1" as ThreadId;

function required<T>(value: T | null): T {
  if (value === null) throw new Error("expected a value");
  return value;
}

function steer(key: string, threadId: ThreadId = THREAD_A): MessageDraft {
  return {
    threadId,
    intent: "steer",
    provenance: { kind: "writer", actorId: "user-1" },
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

describe("Inbox", () => {
  it("claims pending messages in per-thread enqueue order", async () => {
    const inbox = createInMemoryInbox();
    await inbox.enqueue(steer("a1", THREAD_A));
    await inbox.enqueue(steer("b1", THREAD_B));
    await inbox.enqueue(steer("a2", THREAD_A));

    const claimedA = await inbox.claimPending(THREAD_A, "run-1");
    const claimedB = await inbox.claimPending(THREAD_B, "run-1");

    expect(claimedA.map((message) => message.idempotencyKey)).toEqual(["a1", "a2"]);
    expect(claimedA.map((message) => message.seq)).toEqual([1, 3]);
    expect(claimedB.map((message) => message.idempotencyKey)).toEqual(["b1"]);
  });

  it("marks acked messages delivered and stops redelivering them", async () => {
    const inbox = createInMemoryInbox();
    const first = await inbox.enqueue(steer("a1"));
    await inbox.enqueue(steer("a2"));

    await inbox.ack(THREAD_A, [first.id], "run-1");

    const pending = await inbox.claimPending(THREAD_A, "run-1");
    expect(pending.map((message) => message.idempotencyKey)).toEqual(["a2"]);
  });

  it("redelivers unacked messages to the next claim", async () => {
    const inbox = createInMemoryInbox();
    await inbox.enqueue(steer("a1"));

    const firstClaim = await inbox.claimPending(THREAD_A, "run-1");
    const secondClaim = await inbox.claimPending(THREAD_A, "run-1");

    expect(secondClaim.map((message) => message.id)).toEqual(
      firstClaim.map((message) => message.id),
    );
    expect(secondClaim[0]?.deliveredAt).toBeNull();
  });

  it("collapses a duplicate enqueue on the idempotency key", async () => {
    const inbox = createInMemoryInbox();
    const first = await inbox.enqueue(steer("same-key"));
    const second = await inbox.enqueue(steer("same-key"));

    expect(second.id).toBe(first.id);
    expect(second.seq).toBe(first.seq);
    expect(await inbox.claimPending(THREAD_A, "run-1")).toHaveLength(1);
  });

  it("lists distinct pending-steer threads oldest first and excludes system messages", async () => {
    const inbox = createInMemoryInbox();
    await inbox.enqueue(systemMessage("s1", THREAD_A));
    await inbox.enqueue(steer("a1", THREAD_A));
    await inbox.enqueue(steer("b1", THREAD_B));
    await inbox.enqueue(systemMessage("s2", THREAD_B));
    await inbox.enqueue(steer("a2", THREAD_A));

    expect(await inbox.pendingSteerThreads(10)).toEqual([THREAD_A, THREAD_B]);
    expect(await inbox.pendingSteerThreads(1)).toEqual([THREAD_A]);
  });

  it("drops a thread from pending steers once its steer is acked", async () => {
    const inbox = createInMemoryInbox();
    const message = await inbox.enqueue(steer("a1"));
    await inbox.ack(THREAD_A, [message.id], "run-1");

    expect(await inbox.pendingSteerThreads(10)).toEqual([]);
  });
});

describe("RunAuthority", () => {
  function authorityAt(clock: { now: number }) {
    return createInMemoryRunAuthority({
      holderId: "holder-1",
      leaseTtlMs: 1_000,
      now: () => clock.now,
    });
  }

  it("gives a single winner on acquire and blocks the next owner until release", async () => {
    const authority = authorityAt({ now: 0 });
    const lease = required(await authority.acquire(THREAD_A, "run-1"));

    expect(await authority.acquire(THREAD_A, "run-2")).toBeNull();

    await authority.release(lease);
    expect(await authority.acquire(THREAD_A, "run-2")).not.toBeNull();
  });

  it("reports holder and status from the live lease", async () => {
    const authority = authorityAt({ now: 0 });
    expect(await authority.holder(THREAD_A)).toBeNull();
    expect(await authority.read(THREAD_A)).toEqual({ kind: "asleep" });

    const lease = required(await authority.acquire(THREAD_A, "run-1"));
    expect(await authority.holder(THREAD_A)).toBe("run-1");
    expect(await authority.read(THREAD_A)).toEqual({ kind: "awake", phase: "generating" });

    await authority.publish(lease, "waiting");
    expect(await authority.read(THREAD_A)).toEqual({ kind: "awake", phase: "waiting" });
  });

  it("treats an expired lease as no holder and lets a new run steal it", async () => {
    const clock = { now: 0 };
    const authority = authorityAt(clock);
    await authority.acquire(THREAD_A, "run-1");

    clock.now = 1_001;
    expect(await authority.holder(THREAD_A)).toBeNull();
    expect(await authority.read(THREAD_A)).toEqual({ kind: "asleep" });
    expect((await authority.acquire(THREAD_A, "run-2"))?.runId).toBe("run-2");
  });

  it("extends the lease on renew", async () => {
    const clock = { now: 0 };
    const authority = authorityAt(clock);
    const lease = required(await authority.acquire(THREAD_A, "run-1"));

    clock.now = 900;
    await authority.renew(lease);

    clock.now = 1_500;
    expect(await authority.holder(THREAD_A)).toBe("run-1");
    expect(await authority.read(THREAD_A)).toEqual({ kind: "awake", phase: "generating" });
  });

  it("sets the cancel flag once and keeps it idempotent", async () => {
    const authority = authorityAt({ now: 0 });
    await authority.acquire(THREAD_A, "run-1");
    expect(authority.isCancelRequested(THREAD_A)).toBe(false);

    await authority.cancel(THREAD_A);
    await authority.cancel(THREAD_A);
    expect(authority.isCancelRequested(THREAD_A)).toBe(true);
  });

  it("ignores a release from a superseded run", async () => {
    const authority = authorityAt({ now: 0 });
    const first = required(await authority.acquire(THREAD_A, "run-1"));
    await authority.release(first);
    const second = required(await authority.acquire(THREAD_A, "run-2"));

    await authority.release(first);
    expect(await authority.holder(THREAD_A)).toBe("run-2");
    expect(await authority.read(THREAD_A)).toEqual({ kind: "awake", phase: "generating" });
    await authority.release(second);
  });
});

describe("RunStarter", () => {
  it("records the threads it is asked to start", async () => {
    const starter = createInMemoryRunStarter();
    await starter.start(THREAD_A);
    await starter.start(THREAD_B);
    expect(starter.started).toEqual([THREAD_A, THREAD_B]);
  });
});
