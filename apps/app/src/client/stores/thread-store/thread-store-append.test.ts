/**
 * thread-store append/snapshot tests — protects optimistic turn insertion,
 * pending stream handoff, and HTTP/WS snapshot reconciliation into the
 * canonical per-thread `Turn[]` store.
 */

import type { Thread } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";

import { projectQueryKeys } from "@/client/query/project-query-keys";
import { readProjectThreadList } from "@/client/query/project-thread-cache";

import { buildOptimisticUserTurn } from "./build-optimistic-user-turn";
import { createThreadCache } from "./thread-cache";
import { createThreadStore } from "./thread-store";

function thread(id: string): Thread {
  return {
    id,
    projectId: PROJECT_ID,
    workId: null,
    userId: "user_1",
    kind: "primary",
    status: "idle",
    title: id,
    currentAgent: null,
    aiWriteMode: "direct",
    parentThreadId: null,
    rootThreadId: id,
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

const PROJECT_ID = "00000000-0000-4000-8000-000000000000";

let queryClient: QueryClient;

function seedQueryClient(threads: Thread[] | null): QueryClient {
  queryClient = new QueryClient();
  if (threads !== null) {
    queryClient.setQueryData(projectQueryKeys.threads(PROJECT_ID), threads);
  }
  return queryClient;
}

function createStore() {
  return createThreadStore({ now: 0, threadCache: createThreadCache(queryClient) });
}

describe("ensureThread", () => {
  beforeEach(() => {
    seedQueryClient([]);
  });

  it("does not duplicate a thread already in the list", () => {
    seedQueryClient([thread("a")]);
    const store = createStore();
    store.getState().ensureThread(thread("a"));
    expect(readProjectThreadList(queryClient, PROJECT_ID)).toHaveLength(1);
    expect(readProjectThreadList(queryClient, PROJECT_ID)?.[0]?.id).toBe("a");
  });

  it("prepends when the thread id is new", () => {
    seedQueryClient([thread("a")]);
    const store = createStore();
    store.getState().ensureThread(thread("b"));
    expect(readProjectThreadList(queryClient, PROJECT_ID)?.map((t) => t.id)).toEqual(["b", "a"]);
  });
});

describe("markPendingStream", () => {
  it("stores and consumes pending stream metadata in state", () => {
    seedQueryClient([]);
    const store = createStore();
    store.getState().markPendingStream("t1", { after: "cursor-1" });
    expect(store.getState().consumePendingStream("t1")).toEqual({ after: "cursor-1" });
    expect(store.getState().consumePendingStream("t1")).toBeNull();
  });
});

describe("applyThreadSnapshot", () => {
  it("keeps local turns during handoff when the server snapshot is still empty", () => {
    seedQueryClient([thread("handoff")]);
    const store = createThreadStore({ now: 1, threadCache: createThreadCache(queryClient) });
    const local = buildOptimisticUserTurn({
      id: "turn_local_1",
      threadId: "handoff",
      text: "hello",
      now: 1,
    });
    store.setState({
      turnsByThread: { handoff: [local] },
      handoffPendingThreadIds: { handoff: true },
    });

    store.getState().applyThreadSnapshot(thread("handoff"), []);

    expect(store.getState().turns("handoff")).toEqual([local]);
    expect(store.getState().handoffPendingThreadIds.handoff).toBe(true);
    expect(readProjectThreadList(queryClient, PROJECT_ID)?.map((t) => t.id)).toEqual(["handoff"]);
  });

  it("keeps local turns when a stale empty snapshot arrives without handoff pending", () => {
    seedQueryClient([thread("t1")]);
    const store = createStore();
    const local = buildOptimisticUserTurn({
      id: "turn_local_1",
      threadId: "t1",
      text: "draft",
      now: 0,
    });
    store.setState({ turnsByThread: { t1: [local] } });

    store.getState().applyThreadSnapshot(thread("t1"), []);

    expect(store.getState().turns("t1")).toEqual([local]);
  });

  it("clears turns when both server and local snapshots are empty", () => {
    seedQueryClient([thread("t1")]);
    const store = createStore();
    store.setState({ turnsByThread: { t1: [] } });

    store.getState().applyThreadSnapshot(thread("t1"), []);

    expect(store.getState().turns("t1")).toEqual([]);
  });

  it("does not invent a rendered turn from lifecycle liveness alone", () => {
    seedQueryClient([thread("t1")]);
    const store = createStore();

    store.getState().applyThreadSnapshot(thread("t1"), [], {
      runningTurnId: "turn-running",
      waitingForUser: false,
    });

    expect(store.getState().turns("t1")).toEqual([]);
    expect(store.getState().liveMeta.t1).toEqual({
      eventsApplied: 0,
      runningTurnId: "turn-running",
    });
  });

  it("keeps newer local-only turns when the server snapshot is older", () => {
    seedQueryClient([thread("t1")]);
    const store = createStore();
    const older = buildOptimisticUserTurn({
      id: "turn_server",
      threadId: "t1",
      text: "persisted",
      now: 0,
    });
    const newer = buildOptimisticUserTurn({
      id: "turn_local_new",
      threadId: "t1",
      text: "optimistic",
      now: 1,
      prevTurnId: "turn_server",
    });
    store.setState({ turnsByThread: { t1: [older, newer] } });

    store.getState().applyThreadSnapshot(thread("t1"), [older]);

    expect(
      store
        .getState()
        .turns("t1")
        ?.map((t) => t.id),
    ).toEqual(["turn_server", "turn_local_new"]);
  });

  it("replaces local turns when the server returns history", () => {
    seedQueryClient([]);
    const store = createStore();
    const local = buildOptimisticUserTurn({
      id: "turn_local_1",
      threadId: "t1",
      text: "draft",
      now: 0,
    });
    store.setState({
      turnsByThread: { t1: [local] },
      handoffPendingThreadIds: { t1: true },
    });

    const server = [{ ...local, text: "persisted" }];
    store.getState().applyThreadSnapshot(thread("t1"), server);

    expect(store.getState().turns("t1")).toEqual(server);
    expect(store.getState().handoffPendingThreadIds.t1).toBeUndefined();
  });
});
