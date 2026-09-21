/**
 * The settled-run activity emitter. Covers the drain-woken path: a subagent's
 * own run release must emit the root activity frame so the live strip cannot
 * stay frozen at `awake`; a non-subagent thread and any failure are no-ops.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import type { EventJournalWriter } from "../../threads/index.js";
import {
  appendSubagentActivityBestEffort,
  emitSettledRunActivityBestEffort,
} from "./activity-event.js";

const ROOT = "root-thread" as ThreadId;
const CHILD = "child-thread" as ThreadId;

function recordingWriter() {
  const appended: Array<{ threadId: ThreadId; event: unknown }> = [];
  const eventWriter: EventJournalWriter = {
    async appendEvent(threadId, event) {
      appended.push({ threadId, event });
      return BigInt(appended.length);
    },
  };
  return { appended, eventWriter };
}

const readActivity = async () => ({ descendants: [] });

describe("emitSettledRunActivityBestEffort", () => {
  it("emits the root frame after a subagent drain run settles", async () => {
    const { appended, eventWriter } = recordingWriter();
    await emitSettledRunActivityBestEffort({
      findThread: async () => ({ id: CHILD, kind: "subagent", rootThreadId: ROOT }),
      threadId: CHILD,
      eventWriter,
      readActivity,
      eventSink: createInMemoryEventSink(),
    });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.threadId).toBe(ROOT);
    expect((appended[0]?.event as { type: string }).type).toBe("subagent.activity");
  });

  it("does nothing for a non-subagent thread", async () => {
    const { appended, eventWriter } = recordingWriter();
    await emitSettledRunActivityBestEffort({
      findThread: async () => ({ id: ROOT, kind: "primary", rootThreadId: ROOT }),
      threadId: ROOT,
      eventWriter,
      readActivity,
      eventSink: createInMemoryEventSink(),
    });
    expect(appended).toHaveLength(0);
  });

  it("swallows a lookup failure into the event sink", async () => {
    const eventSink = createInMemoryEventSink();
    const { eventWriter } = recordingWriter();
    await expect(
      emitSettledRunActivityBestEffort({
        findThread: async () => {
          throw new Error("db down");
        },
        threadId: CHILD,
        eventWriter,
        readActivity,
        eventSink,
      }),
    ).resolves.toBeUndefined();
    expect(
      eventSink.events.some((event) => event.name === "subagent.activity.settled_emit_failed"),
    ).toBe(true);
  });
});

describe("appendSubagentActivityBestEffort", () => {
  it("reports a failed emission to the sink without throwing", async () => {
    const eventSink = createInMemoryEventSink();
    const eventWriter: EventJournalWriter = {
      async appendEvent() {
        throw new Error("append down");
      },
    };
    await expect(
      appendSubagentActivityBestEffort({
        eventWriter,
        readActivity,
        rootThreadId: ROOT,
        childThreadId: CHILD,
        eventSink,
      }),
    ).resolves.toBeUndefined();
    expect(eventSink.events.some((event) => event.name === "subagent.activity.append_failed")).toBe(
      true,
    );
  });
});
