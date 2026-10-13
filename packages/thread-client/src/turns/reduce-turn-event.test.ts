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

const blockEvent = (id: string): AGUIEvent =>
  ({
    type: EventType.CUSTOM,
    name: "meridian.block.upserted",
    value: {
      block: {
        id,
        turnId: "turn-1",
        blockType: "custom",
        sequence: 1,
        content: { interrupt: { id: "int-1" }, props: {} },
      },
    },
  }) as unknown as AGUIEvent;

const resolvedEvent = {
  type: EventType.CUSTOM,
  name: "meridian.interrupt",
  value: { state: "resolved", turnId: "turn-1", interruptId: "int-1", value: "yes" },
} as unknown as AGUIEvent;

describe("turn reducer", () => {
  it("keeps the typed result beside the model's text, across later tool events", () => {
    const { store, reducer } = instance();
    for (const event of TURN_FIXTURE_EVENTS.slice(0, 14)) reducer.applyEvent(THREAD, event);
    const tool = store.turns(THREAD)?.[0]?.blocks.find((block) => block.blockType === "tool_use");
    expect(tool?.content).toMatchObject({
      output: "committed: ch1.md",
      result: { schema: "meridian.agent-edit.v1", status: "success" },
    });
  });

  it("stamps rows with the injected clock and nothing else", () => {
    const { store, reducer } = instance();
    for (const event of TURN_FIXTURE_EVENTS) reducer.applyEvent(THREAD, event);
    const [turn] = store.turns(THREAD) ?? [];
    expect(turn?.createdAt).toBe(TURN_FIXTURE_NOW);
    expect(turn?.completedAt).toBe(TURN_FIXTURE_NOW);
    expect(turn?.blocks.every((block) => block.createdAt === TURN_FIXTURE_NOW)).toBe(true);
  });

  it("buffers an early interrupt resolution per instance", () => {
    const first = instance();
    const second = instance();
    for (const { reducer } of [first, second]) {
      reducer.applyEvent(THREAD, TURN_FIXTURE_EVENTS[0] as AGUIEvent);
    }
    first.reducer.applyEvent(THREAD, resolvedEvent);
    first.reducer.applyEvent(THREAD, blockEvent("b1"));
    second.reducer.applyEvent(THREAD, blockEvent("b1"));

    const props = (store: InMemoryTurnStore) =>
      (store.turns(THREAD)?.[0]?.blocks[0]?.content as { props: Record<string, unknown> }).props;
    expect(props(first.store)).toMatchObject({ resolvedValue: "yes" });
    expect(props(second.store)).not.toHaveProperty("resolvedValue");

    second.reducer.applyEvent(THREAD, resolvedEvent);
    second.reducer.clearPendingInterruptPatchesForThread(THREAD);
    second.reducer.applyEvent(THREAD, blockEvent("b2"));
    expect(props(second.store)).not.toHaveProperty("resolvedValue");
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
