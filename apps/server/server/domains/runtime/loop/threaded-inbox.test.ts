/**
 * The locked producer enqueue: it holds the per-thread lock across the insert
 * (so it serializes with `closeRun`'s final claim) and fires a best-effort
 * `RunStarter.start` only for steers.
 */

import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import {
  createInMemoryInbox,
  createInMemoryRunStarter,
  createInMemoryThreadLock,
} from "../adapters/in-memory/loop-ports.js";
import type { Inbox, MessageDraft, RunStarter } from "./ports.js";
import type { ThreadLock } from "./thread-lock.js";
import { createThreadedInbox } from "./threaded-inbox.js";

const THREAD_A = "00000000-0000-4000-8000-0000000000a1" as ThreadId;

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createThreadedInbox", () => {
  it("enqueues under the draft thread's lock and wakes on a steer", async () => {
    const lockedThreads: ThreadId[] = [];
    const threadLock: ThreadLock = {
      async withThreadLock(threadId, operation) {
        lockedThreads.push(threadId);
        return operation();
      },
    };
    const inbox = createInMemoryInbox();
    const runStarter = createInMemoryRunStarter();
    const threaded = createThreadedInbox({ inbox, threadLock, runStarter });

    const message = await threaded.enqueue(steer("locked steer"));

    expect(lockedThreads).toEqual([THREAD_A]);
    expect(message.intent).toBe("steer");
    expect(await inbox.claimPending(THREAD_A)).toHaveLength(1);
    expect(runStarter.started).toEqual([THREAD_A]);
  });

  it("does not wake on a system message", async () => {
    const runStarter = createInMemoryRunStarter();
    const threaded = createThreadedInbox({
      inbox: createInMemoryInbox(),
      threadLock: createInMemoryThreadLock(),
      runStarter,
    });

    await threaded.enqueue(systemMessage("context note"));

    expect(runStarter.started).toEqual([]);
  });

  it("serializes concurrent inserts so the second waits on the lock", async () => {
    const threadLock = createInMemoryThreadLock();
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    let insertCount = 0;
    const inbox: Inbox = {
      async enqueue(draft) {
        insertCount += 1;
        const seq = insertCount;
        if (seq === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
        }
        return {
          ...draft,
          id: `message-${seq}`,
          seq,
          enqueuedAt: new Date().toISOString(),
          deliveredAt: null,
        };
      },
      async claimPending() {
        return [];
      },
      async ack() {},
      async pendingSteerThreads() {
        return [];
      },
    };
    const threaded = createThreadedInbox({
      inbox,
      threadLock,
      runStarter: createInMemoryRunStarter(),
    });

    const first = threaded.enqueue(steer("first"));
    await firstEntered.promise;
    let secondDone = false;
    const second = threaded.enqueue(steer("second")).then((message) => {
      secondDone = true;
      return message;
    });
    await Promise.resolve();

    // The first insert still holds the lock, so the second has not entered.
    expect(secondDone).toBe(false);
    expect(insertCount).toBe(1);

    releaseFirst.resolve();
    await first;
    const secondMessage = await second;
    expect(secondDone).toBe(true);
    expect(secondMessage.seq).toBe(2);
  });

  it("keeps the enqueue when the best-effort start rejects", async () => {
    const runStarter: RunStarter = {
      async start() {
        throw new Error("wake failed");
      },
    };
    const inbox = createInMemoryInbox();
    const threaded = createThreadedInbox({
      inbox,
      threadLock: createInMemoryThreadLock(),
      runStarter,
    });

    const message = await threaded.enqueue(steer("wake fails"));

    expect(message.intent).toBe("steer");
    expect(await inbox.claimPending(THREAD_A)).toHaveLength(1);
  });
});
