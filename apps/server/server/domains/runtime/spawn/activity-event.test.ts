/**
 * The drain-woken run activity emitter, used at both the start and settle of a
 * subagent's own run: it must emit the direct parent's activity frame so the live strip
 * reads `awake` during the run and never stays frozen there after release. A
 * non-subagent thread and any failure are no-ops.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import type { EventJournalWriter } from "../../threads/index.js";
import { appendSubagentActivityBestEffort, emitRunActivityBestEffort } from "./activity-event.js";

const ROOT = "root-thread" as ThreadId;
const PARENT = "parent-thread" as ThreadId;
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

const readActivity = async () => ({ children: [] });

describe("emitRunActivityBestEffort", () => {
  it("emits the frame to the direct parent's journal for a subagent drain run", async () => {
    const { appended, eventWriter } = recordingWriter();
    await emitRunActivityBestEffort({
      findThread: async () => ({ id: CHILD, kind: "subagent", parentThreadId: PARENT }),
      threadId: CHILD,
      eventWriter,
      readActivity,
      eventSink: createInMemoryEventSink(),
    });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.threadId).toBe(PARENT);
    expect((appended[0]?.event as { type: string }).type).toBe("subagent.activity");
  });

  it("does nothing for a non-subagent thread", async () => {
    const { appended, eventWriter } = recordingWriter();
    await emitRunActivityBestEffort({
      findThread: async () => ({ id: ROOT, kind: "primary", parentThreadId: null }),
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
      emitRunActivityBestEffort({
        findThread: async () => {
          throw new Error("db down");
        },
        threadId: CHILD,
        eventWriter,
        readActivity,
        eventSink,
      }),
    ).resolves.toBeUndefined();
    expect(eventSink.events.some((event) => event.name === "subagent.activity.emit_failed")).toBe(
      true,
    );
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
        parentThreadId: PARENT,
        childThreadId: CHILD,
        eventSink,
      }),
    ).resolves.toBeUndefined();
    expect(eventSink.events.some((event) => event.name === "subagent.activity.append_failed")).toBe(
      true,
    );
  });
});
