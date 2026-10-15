// @vitest-environment jsdom
/**
 * The app's Zustand store and `InMemoryTurnStore` implement one `TurnStore`.
 * The same event stream must leave both with equal turns after every event, and
 * the stream's end state is the canonical turn contract: the typed tool result
 * survives later events, rows carry the injected clock, blocks sit in sequence
 * order, and an identical rewrite changes nothing.
 */
import { createTurnReducer, InMemoryTurnStore } from "@meridian/thread-client";
import {
  TURN_FIXTURE_EVENTS,
  TURN_FIXTURE_NOW,
  TURN_FIXTURE_REWRITE_EVENT,
  TURN_FIXTURE_THREAD_ID,
} from "@meridian/thread-client/test-support";
import { describe, expect, it } from "vitest";
import { createThreadStore } from "./thread-store";

const THREAD = TURN_FIXTURE_THREAD_ID;

describe("turn store parity", () => {
  it("keeps both stores equal after every event and ends on the canonical turns", () => {
    const clock = () => TURN_FIXTURE_NOW;
    const app = createThreadStore({
      now: Date.parse(TURN_FIXTURE_NOW),
      clock,
      threadCache: {
        upsertThread() {},
        patchThread() {},
        invalidateThread() {},
        invalidateThreadSnapshot() {},
      },
    });
    const memory = new InMemoryTurnStore({ now: clock });
    const reducer = createTurnReducer({ store: memory, now: clock });
    const apply = (event: (typeof TURN_FIXTURE_EVENTS)[number]) => {
      app.getState().applyTurnEvent(THREAD, event);
      reducer.applyEvent(THREAD, event);
    };

    const statuses: unknown[] = [];
    for (const event of TURN_FIXTURE_EVENTS) {
      apply(event);
      expect(app.getState().turns(THREAD)).toEqual(memory.turns(THREAD));
      statuses.push(memory.turns(THREAD)?.[0]?.status);
    }
    expect(statuses).toContain("waiting_interrupt");

    const turns = memory.turns(THREAD) ?? [];
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

    // Forgetting is stamped on both stores alike (by id, held or not) and never cleared by a rewrite.
    app.getState().markForgotten(THREAD, ["turn-2", "not-held"], "turn-3");
    memory.markForgotten(THREAD, ["turn-2", "not-held"], "turn-3");
    expect(app.getState().turns(THREAD)).toEqual(memory.turns(THREAD));
    expect(memory.turns(THREAD)?.map((held) => held.forgottenBy)).toEqual([null, "turn-3"]);

    const memoryBefore = memory.turns(THREAD);
    const appBefore = app.getState().turns(THREAD);
    apply(TURN_FIXTURE_REWRITE_EVENT);
    expect(memory.turns(THREAD)).toBe(memoryBefore);
    expect(app.getState().turns(THREAD)).toBe(appBefore);
  });
});
