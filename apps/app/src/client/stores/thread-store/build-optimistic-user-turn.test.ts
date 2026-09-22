/** Optimistic user rows stay visibly pending until the server acknowledges them. */
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { buildOptimisticUserTurn } from "./build-optimistic-user-turn";
import { createThreadCache } from "./thread-cache";
import { createThreadStore } from "./thread-store";

describe("buildOptimisticUserTurn", () => {
  it("marks the user turn pending with no completion time", () => {
    const turn = buildOptimisticUserTurn({
      id: "turn_local_1",
      threadId: "thread-1",
      text: "Hello",
      now: 0,
    });
    expect(turn.status).toBe("pending");
    expect(turn.completedAt).toBeNull();
    expect(turn.blocks.map((block) => block.status)).toEqual(["complete"]);
  });
});

describe("thread store acknowledgement", () => {
  it("settles the optimistic user row when the server id lands", () => {
    const store = createThreadStore({
      now: 0,
      threadCache: createThreadCache(new QueryClient()),
    });
    const actions = store.getState();
    const optimistic = actions.appendUserTurn("thread-1", "Hello");
    expect(store.getState().turns("thread-1")?.[0]?.status).toBe("pending");

    actions.acknowledgeUserTurn("thread-1", optimistic.id, "turn-server", "43");
    const settled = store.getState().turns("thread-1") ?? [];
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ id: "turn-server", status: "complete" });
  });

  it("does not duplicate a row when acknowledged twice", () => {
    const store = createThreadStore({
      now: 0,
      threadCache: createThreadCache(new QueryClient()),
    });
    const actions = store.getState();
    const optimistic = actions.appendUserTurn("thread-1", "Hello");
    actions.acknowledgeUserTurn("thread-1", optimistic.id, "turn-server", "43");
    actions.acknowledgeUserTurn("thread-1", optimistic.id, "turn-server", "43");
    expect(store.getState().turns("thread-1")).toHaveLength(1);
  });
});
