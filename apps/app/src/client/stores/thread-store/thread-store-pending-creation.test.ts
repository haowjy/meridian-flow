// @ts-nocheck
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { createThreadStore } from "./thread-store";

function makeStore() {
  return createThreadStore({ now: Date.now(), queryClient: new QueryClient() });
}

describe("pending-creation gate", () => {
  it("starts with both maps empty", () => {
    const store = makeStore();
    expect(store.getState().pendingCreation).toEqual({ workbenchIds: {}, threadIds: {} });
  });

  it("marks a (workbenchId, threadId) pair", () => {
    const store = makeStore();
    store.getState().markPendingCreation({ workbenchId: "p1", threadId: "t1" });

    expect(store.getState().pendingCreation).toEqual({
      workbenchIds: { p1: true },
      threadIds: { t1: true },
    });
  });

  it("clears only the requested ids, preserving other entries", () => {
    const store = makeStore();
    store.getState().markPendingCreation({ workbenchId: "p1", threadId: "t1" });
    store.getState().markPendingCreation({ workbenchId: "p2", threadId: "t2" });

    store.getState().clearPendingCreation({ workbenchId: "p1", threadId: "t1" });

    expect(store.getState().pendingCreation).toEqual({
      workbenchIds: { p2: true },
      threadIds: { t2: true },
    });
  });

  it("allows clearing only the workbench or thread side", () => {
    const store = makeStore();
    store.getState().markPendingCreation({ workbenchId: "p1", threadId: "t1" });

    store.getState().clearPendingCreation({ workbenchId: "p1" });
    expect(store.getState().pendingCreation).toEqual({
      workbenchIds: {},
      threadIds: { t1: true },
    });

    store.getState().clearPendingCreation({ threadId: "t1" });
    expect(store.getState().pendingCreation).toEqual({ workbenchIds: {}, threadIds: {} });
  });
});
