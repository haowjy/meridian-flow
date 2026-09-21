/**
 * The locked producer enqueue: it holds the per-thread lock across the insert
 * (so it serializes with `closeRun`'s final claim) and fires a best-effort
 * `RunStarter.start` only for messages.
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

function message(key: string, threadId: ThreadId = THREAD_A): MessageDraft {
  return {
    threadId,
    intent: "message",
    provenance: { kind: "writer", actorId: "user-1" },
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createThreadedInbox", () => {
  it("enqueues under the draft thread's lock and wakes on a message", async () => {
    const lockedThreads: ThreadId[] = [];
    const threadLock: ThreadLock = {
      async withThreadLock(threadId, operation) {
        lockedThreads.push(threadId);
        return operation();
      },
    };
    const inbox = createInMemoryInbox();
    const runStarter = createInMemoryRunStarter();
    const threaded = createThreadedInbox({
      inbox,
      threadLock,
      runStarter,
      schedulePostCommit: (task) => task(),
    });

    const inboxMessage = await threaded.enqueue(message("locked steer"));

    expect(lockedThreads).toEqual([THREAD_A]);
    expect(inboxMessage.intent).toBe("message");
    expect(await inbox.claimPending(THREAD_A)).toHaveLength(1);
    expect(runStarter.started).toEqual([THREAD_A]);
  });

  it("does not wake on a notice", async () => {
    const runStarter = createInMemoryRunStarter();
    const threaded = createThreadedInbox({
      inbox: createInMemoryInbox(),
      threadLock: createInMemoryThreadLock(),
      runStarter,
      schedulePostCommit: (task) => task(),
    });

    await threaded.enqueue(notice("context note"));

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
      async listPending() {
        return [];
      },
      async ack() {},
      async pendingMessageThreads() {
        return [];
      },
    };
    const threaded = createThreadedInbox({
      inbox,
      threadLock,
      runStarter: createInMemoryRunStarter(),
      schedulePostCommit: (task) => task(),
    });

    const first = threaded.enqueue(message("first"));
    await firstEntered.promise;
    let secondDone = false;
    const second = threaded.enqueue(message("second")).then((message) => {
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
      schedulePostCommit: (task) => task(),
    });

    const inboxMessage = await threaded.enqueue(message("wake fails"));

    expect(inboxMessage.intent).toBe("message");
    expect(await inbox.claimPending(THREAD_A)).toHaveLength(1);
  });

  it("defers the wake to the post-commit scheduler instead of firing inline", async () => {
    const runStarter = createInMemoryRunStarter();
    const scheduled: Array<() => Promise<void>> = [];
    const threaded = createThreadedInbox({
      inbox: createInMemoryInbox(),
      threadLock: createInMemoryThreadLock(),
      runStarter,
      schedulePostCommit(task) {
        scheduled.push(task);
      },
    });

    await threaded.enqueue(message("deferred wake"));

    // The wake must not resolve the caller's still-open transaction.
    expect(runStarter.started).toEqual([]);
    expect(scheduled).toHaveLength(1);
    await scheduled[0]?.();
    expect(runStarter.started).toEqual([THREAD_A]);
  });
});
