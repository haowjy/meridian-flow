/** Ordering and coalescing laws for the per-frame stream delta coalescer. */
import { type AGUIEvent, EventType } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { StreamDeltaCoalescer } from "./stream-delta-coalescer";

type Scheduled = { run: () => void; cancelled: boolean };

function manualScheduler() {
  const scheduled: Scheduled[] = [];
  const schedule = (flush: () => void) => {
    const entry: Scheduled = { run: flush, cancelled: false };
    scheduled.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const runNext = () => scheduled.find((entry) => !entry.cancelled)?.run();
  return { schedule, runNext, scheduled };
}

function content(messageId: string, delta: string): AGUIEvent {
  return { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta } as AGUIEvent;
}

function reasoning(messageId: string, delta: string): AGUIEvent {
  return { type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta } as AGUIEvent;
}

function finish(): AGUIEvent {
  return { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as AGUIEvent;
}

describe("StreamDeltaCoalescer", () => {
  it("flushes a pending run before a non-mergeable event", () => {
    const { schedule } = manualScheduler();
    const applied: AGUIEvent[] = [];
    const coalescer = new StreamDeltaCoalescer((event) => applied.push(event), schedule);

    coalescer.push(content("m1", "a"));
    coalescer.push(finish());

    expect(applied.map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.RUN_FINISHED,
    ]);
    expect(applied[0]).toMatchObject({ delta: "a" });
  });

  it("does not merge across message or block-kind boundaries", () => {
    const { schedule, runNext } = manualScheduler();
    const applied: AGUIEvent[] = [];
    const coalescer = new StreamDeltaCoalescer((event) => applied.push(event), schedule);

    coalescer.push(content("m1", "a"));
    coalescer.push(reasoning("m1", "b"));
    coalescer.push(content("m2", "c"));

    expect(applied).toHaveLength(2);
    expect(applied[0]).toMatchObject({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "a" });
    expect(applied[1]).toMatchObject({ type: EventType.REASONING_MESSAGE_CONTENT, delta: "b" });
    runNext();
    expect(applied[2]).toMatchObject({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "c" });
  });
});
