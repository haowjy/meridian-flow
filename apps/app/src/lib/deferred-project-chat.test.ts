import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { createThreadCache } from "@/client/stores/thread-store/thread-cache";
import { createThreadStore } from "@/client/stores/thread-store/thread-store";

import { DeferredFirstSendLatch, startDeferredProjectChat } from "./deferred-project-chat";

describe("startDeferredProjectChat", () => {
  it("seeds an optimistic thread and marks only the thread pending (not the project)", () => {
    const queryClient = new QueryClient();
    const store = createThreadStore({
      now: 1_700_000_000_000,
      threadCache: createThreadCache(queryClient),
    });
    const actions = store.getState();

    const { threadId } = startDeferredProjectChat({
      projectId: "wb-1",
      threadActions: actions,
      title: "New chat",
      now: 1_700_000_000_000,
    });

    expect(threadId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(store.getState().pendingCreation).toEqual({
      projectIds: {},
      threadIds: { [threadId]: true },
    });
    expect(actions.turns(threadId)).toEqual([]);
  });
});

describe("DeferredFirstSendLatch", () => {
  it("blocks a second acquire until release", () => {
    const latch = new DeferredFirstSendLatch();
    expect(latch.tryAcquire()).toBe(true);
    expect(latch.tryAcquire()).toBe(false);
    latch.release();
    expect(latch.tryAcquire()).toBe(true);
  });
});

describe("deferred first-send failure rollback", () => {
  it("removes the optimistic user turn so retry can resubmit", () => {
    const queryClient = new QueryClient();
    const store = createThreadStore({
      now: 1_700_000_000_000,
      threadCache: createThreadCache(queryClient),
    });
    const actions = store.getState();

    const { threadId } = startDeferredProjectChat({
      projectId: "wb-1",
      threadActions: actions,
      title: "New chat",
    });
    const turn = actions.appendUserTurn(threadId, "hello");
    expect(actions.turns(threadId)).toHaveLength(1);

    actions.removeOptimisticUserTurn(threadId, turn.id);

    expect(actions.turns(threadId)).toEqual([]);
    expect(store.getState().pendingCreation.threadIds[threadId]).toBe(true);
  });
});
