import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { createThreadStore } from "./thread-store";

function makeStore() {
  return createThreadStore({ now: Date.now(), queryClient: new QueryClient() });
}

describe("pending-creation gate", () => {
  it("starts with both maps empty", () => {
    const store = makeStore();
    expect(store.getState().pendingCreation).toEqual({ projectIds: {}, threadIds: {} });
  });

  it("marks a (projectId, threadId) pair", () => {
    const store = makeStore();
    store.getState().markPendingCreation({ projectId: "p1", threadId: "t1" });

    expect(store.getState().pendingCreation).toEqual({
      projectIds: { p1: true },
      threadIds: { t1: true },
    });
  });

  it("clears only the requested ids, preserving other entries", () => {
    const store = makeStore();
    store.getState().markPendingCreation({ projectId: "p1", threadId: "t1" });
    store.getState().markPendingCreation({ projectId: "p2", threadId: "t2" });

    store.getState().clearPendingCreation({ projectId: "p1", threadId: "t1" });

    expect(store.getState().pendingCreation).toEqual({
      projectIds: { p2: true },
      threadIds: { t2: true },
    });
  });

  it("allows clearing only the project or thread side", () => {
    const store = makeStore();
    store.getState().markPendingCreation({ projectId: "p1", threadId: "t1" });

    store.getState().clearPendingCreation({ projectId: "p1" });
    expect(store.getState().pendingCreation).toEqual({
      projectIds: {},
      threadIds: { t1: true },
    });

    store.getState().clearPendingCreation({ threadId: "t1" });
    expect(store.getState().pendingCreation).toEqual({ projectIds: {}, threadIds: {} });
  });
});
