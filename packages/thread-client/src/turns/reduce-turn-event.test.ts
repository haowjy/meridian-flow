/**
 * The reducer against the package's plain store: tool results, instance-owned
 * interrupt buffering, and the injected clock.
 */
import type { AGUIEvent, Turn } from "@meridian/contracts/protocol";
import { EventType } from "@meridian/contracts/protocol";
import { answeredControlIds, readWriteModeSwitch } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import {
  TURN_FIXTURE_EVENTS,
  TURN_FIXTURE_NOW,
  TURN_FIXTURE_REWRITE_EVENT,
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

    // The fixture stream's end state is the canonical turn contract: the typed tool result
    // survives later events, rows carry the injected clock, blocks sit in sequence order, and an
    // identical rewrite changes nothing.
    const whole = instance();
    const statuses: unknown[] = [];
    for (const event of TURN_FIXTURE_EVENTS) {
      whole.reducer.applyEvent(THREAD, event);
      statuses.push(whole.store.turns(THREAD)?.[0]?.status);
    }
    expect(statuses).toContain("waiting_interrupt");
    const turns = whole.store.turns(THREAD) ?? [];
    expect(turns.map((turn) => [turn.id, turn.status])).toEqual([
      ["turn-1", "complete"],
      ["turn-2", "error"],
    ]);
    const [turn] = turns;
    expect(turn?.blocks.map((block) => [block.sequence, block.id])).toEqual([
      [0, "m1"],
      [1, "turn-1::1"],
      [2, "tool-call-1"],
      [3, "interrupt-block-1"],
      [4, "m2"],
      [5, expect.stringMatching(/^text_[1-9]\d*$/)],
      [7, "late-b"],
      [9, "late-c"],
    ]);
    expect(turn?.blocks.find((block) => block.blockType === "tool_use")?.content).toMatchObject({
      output: "committed: ch1.md",
      result: { schema: "meridian.agent-edit.v1", status: "success" },
    });
    expect(turn?.createdAt).toBe(TURN_FIXTURE_NOW);
    expect(turn?.completedAt).toBe(TURN_FIXTURE_NOW);
    expect(turn?.blocks.every((block) => block.createdAt === TURN_FIXTURE_NOW)).toBe(true);
    const before = whole.store.turns(THREAD);
    whole.reducer.applyEvent(THREAD, TURN_FIXTURE_REWRITE_EVENT);
    expect(whole.store.turns(THREAD)).toBe(before);
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
  it("stamps forgotten turns whether or not they are held yet, and no older snapshot clears the stamp", () => {
    // Risk: a forgotten turn drawn again because its stamp arrived before its turn was hydrated (a user
    // turn's creation gives the client no row), or because a snapshot read before the commit lacked it.
    const { store, reducer } = instance();
    const forgotten = (...turnIds: string[]) =>
      ({
        type: EventType.CUSTOM,
        name: "meridian.turns.forgotten",
        value: { turnIds, byTurnId: "next", reason: "forgotten" },
      }) as unknown as AGUIEvent;
    const turn = (id: string) =>
      ({ id, role: "user", blocks: [], forgottenBy: null }) as unknown as Turn;
    const stamps = () => store.turns(THREAD)?.map((held) => [held.id, held.forgottenBy]);
    store.hydrate(THREAD, [turn("u1"), turn("f1")], "5000");
    reducer.applyEvent(THREAD, forgotten("f1", "u0"), "7000");
    expect(stamps()).toEqual([
      ["u1", null],
      ["f1", "next"],
    ]);
    // A snapshot read before the commit lacks the stamp; so does one that hydrates u0 for the first time.
    store.hydrate(THREAD, [turn("u0"), turn("u1"), turn("f1")], "6000");
    expect(stamps()).toEqual([
      ["u0", "next"],
      ["u1", null],
      ["f1", "next"],
    ]);
    // Write-once: a second frame naming f1 keeps its first forgetting turn.
    reducer.applyEvent(
      THREAD,
      {
        type: EventType.CUSTOM,
        name: "meridian.turns.forgotten",
        value: { turnIds: ["f1"], byTurnId: "later", reason: "forgotten" },
      } as unknown as AGUIEvent,
      "7100",
    );
    expect(stamps()?.[2]).toEqual(["f1", "next"]);
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
    // Risk (F19): a queued switch's row retires on its control id in the store's turns, so the
    // answered set holds a divider's id only once the divider is placed, never while it is held.
    expect([...answeredControlIds(turns)]).toEqual(["c-d1", "c-d2"]);
    // A snapshot read before both frames keeps both where they were.
    store.hydrate(THREAD, replies, "6000");
    expect(ids(store)).toEqual(["r1", "d1", "r2a", "r2b", "d2", "r3"]);
    // An anchor the store lacks is no guess: the divider is held out, and placed once a snapshot
    // brings the anchor.
    reducer.applyEvent(THREAD, frame("d3", "m9", 9), "7200");
    expect(ids(store)).toEqual(["r1", "d1", "r2a", "r2b", "d2", "r3"]);
    // The store says which held dividers still wait, with the frame's seq: the one rule hosts ask.
    expect(store.dividersAwaitingAnchor(THREAD)).toEqual([{ turnId: "d3", seq: "7200" }]);
    expect(answeredControlIds(store.turns(THREAD) ?? []).has("c-d3")).toBe(false);
    store.hydrate(THREAD, [...replies, t("m9", "r3")], "6500");
    expect(ids(store)).toEqual(["r1", "d1", "r2a", "r2b", "d2", "r3", "m9", "d3"]);
    expect(answeredControlIds(store.turns(THREAD) ?? []).has("c-d3")).toBe(true);
    expect(store.dividersAwaitingAnchor(THREAD)).toEqual([]);
    // The covering snapshot's stored turn replaces the divider by id; a later one without it drops it.
    const stored = { ...turns[1], position: 3 } as Turn;
    store.hydrate(THREAD, [turns[0] as Turn, stored, ...replies.slice(1)], "7001");
    expect(store.turns(THREAD)?.[1]).toBe(stored);
    // Risk (review N2): a covering snapshot that excludes a waiting divider and never brings its
    // anchor must release it, or a host asks for a refresh forever.
    reducer.applyEvent(THREAD, frame("d4", "m10", 10), "7300");
    // (d3 waits again: the 7001 snapshot did not cover its frame and lacks m9.)
    expect(store.dividersAwaitingAnchor(THREAD)).toEqual([
      { turnId: "d3", seq: "7200" },
      { turnId: "d4", seq: "7300" },
    ]);
    store.hydrate(THREAD, replies, "8000");
    expect(ids(store)).toEqual(["r1", "r2a", "r2b", "r3"]);
    expect(store.dividersAwaitingAnchor(THREAD)).toEqual([]);
  });
});
