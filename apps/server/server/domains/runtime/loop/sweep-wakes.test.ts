/** The wake sweep's derived need: pending messages with no live holder start a run. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createInMemoryInbox, createInMemoryRunClaim } from "../adapters/in-memory/loop-ports.js";
import type { MessageDraft } from "./ports.js";
import { sweepWakes } from "./sweep-wakes.js";

const THREAD_A = "thread-a" as ThreadId;
const THREAD_B = "thread-b" as ThreadId;

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

describe("sweepWakes", () => {
  it("pages past poisoned candidates and wraps to retry them", async () => {
    const inbox = createInMemoryInbox();
    const authority = createInMemoryRunClaim();
    await inbox.enqueue(message("a", THREAD_A));
    await inbox.enqueue(message("b", THREAD_B));
    const started: ThreadId[] = [];
    let afterThreadId: ThreadId | undefined;
    for (let i = 0; i < 3; i++) {
      ({ cursor: afterThreadId } = await sweepWakes({
        eventSink: createInMemoryEventSink(),
        delivery: { ...inbox, async refreshPending() {} },
        authority,
        limit: 1,
        afterThreadId,
        runStarter: {
          async start(id) {
            started.push(id);
            if (id === THREAD_A) throw new Error("exhausted balance");
          },
        },
      }));
    }
    expect(started).toEqual([THREAD_A, THREAD_B, THREAD_A]);
  });
});
