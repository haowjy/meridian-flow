// @vitest-environment jsdom
/**
 * The app's Zustand store and `InMemoryTurnStore` implement one `TurnStore`.
 * The same event stream must leave both with equal turns, so a change to either
 * store's turn handling that the other does not share fails here.
 */
import { createTurnReducer, InMemoryTurnStore } from "@meridian/thread-client";
import {
  TURN_FIXTURE_EVENTS,
  TURN_FIXTURE_NOW,
  TURN_FIXTURE_THREAD_ID,
} from "@meridian/thread-client/test-support";
import { describe, expect, it } from "vitest";
import { createThreadStore } from "./thread-store";

describe("turn store parity", () => {
  it("builds equal turns from run, text, reasoning, tool, interrupt, finish and error events", () => {
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

    for (const event of TURN_FIXTURE_EVENTS) {
      app.getState().applyTurnEvent(TURN_FIXTURE_THREAD_ID, event);
      reducer.applyEvent(TURN_FIXTURE_THREAD_ID, event);
    }

    const turns = memory.turns(TURN_FIXTURE_THREAD_ID);
    expect(turns?.map((turn) => [turn.id, turn.status])).toEqual([
      ["turn-1", "complete"],
      ["turn-2", "error"],
    ]);
    expect(app.getState().turns(TURN_FIXTURE_THREAD_ID)).toEqual(turns);
  });
});
