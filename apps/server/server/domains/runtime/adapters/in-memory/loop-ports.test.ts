/** Unit coverage for the in-memory loop ports: inbox ordering/ack and run authority leases. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { closeRun } from "../../loop/close-run.js";
import type { MessageDraft } from "../../loop/ports.js";
import {
  createInMemoryInbox,
  createInMemoryRunAuthority,
  createInMemoryThreadLock,
} from "./loop-ports.js";

const THREAD_A = "00000000-0000-4000-8000-0000000000a1" as ThreadId;

function required<T>(value: T | null): T {
  if (value === null) throw new Error("expected a value");
  return value;
}

function message(key: string, threadId: ThreadId = THREAD_A): MessageDraft {
  return {
    threadId,
    intent: "message",
    provenance: { kind: "writer", actorId: "user-1" },
    body: { kind: "text", text: key },
    idempotencyKey: key,
  };
}

describe("closeRun", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("completes the terminal turn before releasing the lease", async () => {
    const inbox = createInMemoryInbox();
    const authority = createInMemoryRunAuthority({ holderId: "holder-1" });
    const threadLock = createInMemoryThreadLock();
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
    // The lease is still held while the terminal write is in flight, so no
    // second run can acquire mid-terminal.
    expect(await authority.acquire(THREAD_A, "run-2")).toBeNull();
    expect(await authority.holder(THREAD_A)).toBe("run-1");

    allowComplete.resolve();
    expect(await closing).toEqual({ kind: "completed", completion: "terminal" });
    expect(await authority.holder(THREAD_A)).toBeNull();
    expect(await authority.acquire(THREAD_A, "run-2")).not.toBeNull();
  });

  it("completes and releases despite a pending batch when continueOnPending is false", async () => {
    const inbox = createInMemoryInbox();
    const authority = createInMemoryRunAuthority({ holderId: "holder-1" });
    const threadLock = createInMemoryThreadLock();
    const lease = required(await authority.acquire(THREAD_A, "run-1"));
    await inbox.enqueue(message("unrecoverable here"));

    const outcome = await closeRun({
      threadLock,
      inbox,
      runAuthority: authority,
      threadId: THREAD_A,
      lease,
      continueOnPending: false,
      complete: async () => "terminal",
    });

    expect(outcome).toEqual({ kind: "completed", completion: "terminal" });
    expect(await authority.holder(THREAD_A)).toBeNull();
    // The pending message is left for the wake sweep, not acked.
    expect(await inbox.claimPending(THREAD_A)).toHaveLength(1);
  });
});
