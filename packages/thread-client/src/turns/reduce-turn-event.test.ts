/**
 * The reducer against the package's plain store: tool results, instance-owned
 * interrupt buffering, injected clock, and the store's snapshot floor.
 */
import type { AGUIEvent } from "@meridian/contracts/protocol";
import { EventType } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import {
  TURN_FIXTURE_EVENTS,
  TURN_FIXTURE_NOW,
  TURN_FIXTURE_THREAD_ID,
} from "../test-support/turn-events";
import { InMemoryTurnStore } from "./in-memory-turn-store";
import { createTurnReducer } from "./reduce-turn-event";

const THREAD = TURN_FIXTURE_THREAD_ID;

function instance(now = () => TURN_FIXTURE_NOW) {
  const store = new InMemoryTurnStore({ now });
  return { store, reducer: createTurnReducer({ store, now }) };
}

const blockEvent = (id: string, interruptId = "int-1", sequence = 1): AGUIEvent =>
  ({
    type: EventType.CUSTOM,
    name: "meridian.block.upserted",
    value: {
      block: {
        id,
        turnId: "turn-1",
        blockType: "custom",
        sequence,
        content: { interrupt: { id: interruptId }, props: {} },
      },
    },
  }) as unknown as AGUIEvent;

const resolvedEvent = (interruptId = "int-1") =>
  ({
    type: EventType.CUSTOM,
    name: "meridian.interrupt",
    value: { state: "resolved", turnId: "turn-1", interruptId, value: "yes" },
  }) as unknown as AGUIEvent;

describe("turn reducer", () => {
  it("buffers an early interrupt resolution per instance", () => {
    const first = instance();
    const second = instance();
    for (const { reducer } of [first, second]) {
      reducer.applyEvent(THREAD, TURN_FIXTURE_EVENTS[0] as AGUIEvent);
    }
    first.reducer.applyEvent(THREAD, resolvedEvent());
    first.reducer.applyEvent(THREAD, blockEvent("b1"));
    second.reducer.applyEvent(THREAD, blockEvent("b1"));

    const props = (store: InMemoryTurnStore) =>
      (store.turns(THREAD)?.[0]?.blocks[0]?.content as { props: Record<string, unknown> }).props;
    expect(props(first.store)).toMatchObject({ resolvedValue: "yes" });
    expect(props(second.store)).not.toHaveProperty("resolvedValue");

    // int-2 is resolved before its block exists, so the resolution is buffered.
    second.reducer.applyEvent(THREAD, resolvedEvent("int-2"));
    second.reducer.clearPendingInterruptPatchesForThread(THREAD);
    second.reducer.applyEvent(THREAD, blockEvent("b2", "int-2", 2));
    const late = second.store.turns(THREAD)?.[0]?.blocks.find((block) => block.id === "b2");
    expect(late?.content).not.toHaveProperty("props.resolvedValue");
  });
});

describe("InMemoryTurnStore", () => {
  it("rejects a snapshot older than the accepted floor and events it already covers", () => {
    const { store } = instance();
    expect(store.hydrate(THREAD, [], "10")).toBe(true);
    expect(store.hydrate(THREAD, [], "9")).toBe(false);
    expect(store.acceptEventSeq(THREAD, "9")).toBe(false);
    expect(store.acceptEventSeq(THREAD, "10")).toBe(true);
    expect(store.nextSeq(THREAD)).toBe("11");
    expect(store.hydrate(THREAD, [], "10")).toBe(false);
  });
});
