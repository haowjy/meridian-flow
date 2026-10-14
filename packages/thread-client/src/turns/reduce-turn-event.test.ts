/**
 * The reducer against the package's plain store: tool results, instance-owned
 * interrupt buffering, and the injected clock.
 */
import type { AGUIEvent, Turn } from "@meridian/contracts/protocol";
import { EventType } from "@meridian/contracts/protocol";
import { readWriteModeSwitch } from "@meridian/contracts/threads";
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

  describe("a handed-back message leaving the conversation", () => {
    const user = (id: string) => ({ id, role: "user", blocks: [] }) as unknown as Turn;
    const handedBack = (...ids: string[]) =>
      ({
        type: EventType.CUSTOM,
        name: "meridian.messages.handed_back",
        value: { userTurnIds: ids },
      }) as unknown as AGUIEvent;
    const ids = (store: InMemoryTurnStore) => store.turns(THREAD)?.map((turn) => turn.id);

    it("stays gone against a snapshot read before the removal, until a snapshot covers it", () => {
      // Risk: a hand-back frame undone by an older in-flight snapshot, or a tombstone that
      // outlives the snapshot that no longer has the turn.
      const { store, reducer } = instance();
      store.hydrate(THREAD, [user("m1"), user("m2")], "5000");
      reducer.applyEvent(THREAD, handedBack("m2"), "7000");
      expect(ids(store)).toEqual(["m1"]);
      // Read before the removal (covers up to seq 6999): still lists m2.
      store.hydrate(THREAD, [user("m1"), user("m2")], "6000");
      expect(ids(store)).toEqual(["m1"]);
      // A snapshot at or past the removal lacks it; the tombstone is spent, so a later
      // appearance of the id is real.
      store.hydrate(THREAD, [user("m1")], "7001");
      store.hydrate(THREAD, [user("m1"), user("m2")], "8000");
      expect(ids(store)).toEqual(["m1", "m2"]);
    });

    it("is a no-op when the hand-back answer removed the turns before the frame", () => {
      // Risk: the answer and the frame each removing, or the second one failing or re-adding.
      const { store, reducer } = instance();
      store.hydrate(THREAD, [user("m1"), user("m2")], "5000");
      store.removeTurns(THREAD, ["m2", "gone-already"], "7999");
      const before = store.turns(THREAD);
      reducer.applyEvent(THREAD, handedBack("m2"), "7000");
      expect(store.turns(THREAD)).toBe(before);
      // The later of two removals' seqs holds: a snapshot between them cannot revive m2.
      store.hydrate(THREAD, [user("m1"), user("m2")], "7500");
      expect(ids(store)).toEqual(["m1"]);
    });
  });
  it("places a switch's divider by the anchor its frame names, and a stale snapshot keeps it there", () => {
    // Risk (#760 review B1): a divider put at the tail lands after a reply that finished before
    // the frame, a snapshot, or a second switch, and its notice then jumps. Also: an answered
    // switch showing queued again when a snapshot read before the frame drops the divider.
    const { store, reducer } = instance();
    const ids = (of: InMemoryTurnStore) => of.turns(THREAD)?.map((turn) => turn.id);
    const t = (id: string, prevTurnId: string | null) =>
      ({ id, role: "assistant", prevTurnId, blocks: [] }) as unknown as Turn;
    // r2a and r2b are one reply split by an autocompaction; r3 is a later reply.
    const replies = [t("r1", null), t("r2a", "r1"), t("r2b", "r2a"), t("r3", "r2b")];
    store.hydrate(THREAD, replies, "5000");
    const frame = (turnId: string, prevTurnId: string | null, position: number) =>
      ({
        type: EventType.CUSTOM,
        name: "meridian.write_mode.switched",
        value: {
          threadId: THREAD,
          mode: "draft",
          controlId: `c-${turnId}`,
          turnId,
          prevTurnId,
          position,
        },
      }) as unknown as AGUIEvent;
    // Two switches in the window, the first before the reply's first part.
    reducer.applyEvent(THREAD, frame("d1", "r1", 1), "7000");
    reducer.applyEvent(THREAD, frame("d1", "r1", 1), "7000");
    reducer.applyEvent(THREAD, frame("d2", "r2b", 4), "7100");
    expect(ids(store)).toEqual(["r1", "d1", "r2a", "r2b", "d2", "r3"]);
    const turns = store.turns(THREAD) ?? [];
    expect(readWriteModeSwitch(turns[1] as Turn)).toEqual({ mode: "draft", controlId: "c-d1" });
    // A snapshot read before both frames keeps both where they were.
    store.hydrate(THREAD, replies, "6000");
    expect(ids(store)).toEqual(["r1", "d1", "r2a", "r2b", "d2", "r3"]);
    // An anchor the store lacks is no guess: the divider is held out, and placed once a snapshot
    // brings the anchor.
    reducer.applyEvent(THREAD, frame("d3", "m9", 9), "7200");
    expect(ids(store)).toEqual(["r1", "d1", "r2a", "r2b", "d2", "r3"]);
    store.hydrate(THREAD, [...replies, t("m9", "r3")], "6500");
    expect(ids(store)).toEqual(["r1", "d1", "r2a", "r2b", "d2", "r3", "m9", "d3"]);
    // The covering snapshot's stored turn replaces the divider by id; a later one without it drops it.
    const stored = { ...turns[1], position: 3 } as Turn;
    store.hydrate(THREAD, [turns[0] as Turn, stored, ...replies.slice(1)], "7001");
    expect(store.turns(THREAD)?.[1]).toBe(stored);
    store.hydrate(THREAD, replies, "8000");
    expect(ids(store)).toEqual(["r1", "r2a", "r2b", "r3"]);
  });
});
