/** The wake sweep's derived need: pending messages with no live holder start a run. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import {
  createInMemoryInbox,
  createInMemoryRunAuthority,
} from "../adapters/in-memory/loop-ports.js";
import type { MessageDraft } from "./ports.js";
import { sweepWakes } from "./sweep-wakes.js";

const THREAD_A = "thread-a" as ThreadId;
const THREAD_B = "thread-b" as ThreadId;
const THREAD_C = "thread-c" as ThreadId;

const USER_ID = "user-1";

function message(key: string, threadId: ThreadId): MessageDraft {
  return {
    threadId,
    intent: "message",
    provenance: { kind: "writer", actorId: USER_ID },
    body: { kind: "text", text: key },
    idempotencyKey: key,
  };
}

function notice(key: string, threadId: ThreadId): MessageDraft {
  return {
    threadId,
    intent: "notice",
    provenance: { kind: "system", source: "work" },
    body: { kind: "context", parts: [{ source: "work", text: key }] },
    idempotencyKey: key,
  };
}

function recordingStarter(started: ThreadId[]) {
  return {
    async start(threadId: ThreadId) {
      started.push(threadId);
    },
  };
}

describe("sweepWakes", () => {
  it("starts a pending-message thread with no holder and skips a live holder", async () => {
    const inbox = createInMemoryInbox();
    const authority = createInMemoryRunAuthority();
    await inbox.enqueue(message("a", THREAD_A));
    await inbox.enqueue(message("b", THREAD_B));
    await inbox.enqueue(notice("s", THREAD_C));
    const lease = await authority.acquire(THREAD_A, "run-a");

    const started: ThreadId[] = [];
    await sweepWakes({ inbox, authority, runStarter: recordingStarter(started), limit: 10 });

    // THREAD_A is live, THREAD_C has no message, only THREAD_B wakes.
    expect(started).toEqual([THREAD_B]);
    if (lease) await authority.release(lease);
  });

  it("respects the limit over the oldest pending-message threads", async () => {
    const inbox = createInMemoryInbox();
    const authority = createInMemoryRunAuthority();
    await inbox.enqueue(message("a", THREAD_A));
    await inbox.enqueue(message("b", THREAD_B));
    await inbox.enqueue(message("c", THREAD_C));

    const started: ThreadId[] = [];
    await sweepWakes({ inbox, authority, runStarter: recordingStarter(started), limit: 2 });

    expect(started).toEqual([THREAD_A, THREAD_B]);
  });

  it("keeps sweeping when one thread's start fails", async () => {
    const inbox = createInMemoryInbox();
    const authority = createInMemoryRunAuthority();
    await inbox.enqueue(message("a", THREAD_A));
    await inbox.enqueue(message("b", THREAD_B));

    const started: ThreadId[] = [];
    await sweepWakes({
      inbox,
      authority,
      runStarter: {
        async start(threadId) {
          started.push(threadId);
          if (threadId === THREAD_A) throw new Error("boom");
        },
      },
      limit: 10,
    });

    expect(started).toEqual([THREAD_A, THREAD_B]);
  });
});
