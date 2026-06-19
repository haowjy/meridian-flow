/**
 * thread-store unified-block action tests — covers live assistant turn/block
 * store mutations plus their project-thread-list lifecycle cache patches.
 *
 * The tests lock store-side behavior at the boundary where AG-UI reducer events
 * become rendered chat turns and sidebar row state.
 */

import type { Block, ThreadListItem } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { projectQueryKeys } from "@/client/query/project-query-keys";
import { lifecycleFor } from "@/features/project/lifecycle";

import { createThreadCache } from "./thread-cache";
import { createThreadStore } from "./thread-store";
import type { TurnStatusPatch } from "./types";

function makeStore(now = Date.parse("2026-01-01T00:00:00.000Z")) {
  return createThreadStore({ now, threadCache: createThreadCache(new QueryClient()) });
}

const PROJECT_ID = "project-1";

function threadListItem(overrides: Partial<ThreadListItem> = {}): ThreadListItem {
  return {
    id: "thread-1",
    projectId: PROJECT_ID,
    workId: null,
    userId: "user-1",
    kind: "primary",
    status: "idle",
    title: "Thread",
    currentAgent: null,
    parentThreadId: null,
    rootThreadId: overrides.rootThreadId ?? overrides.id ?? "thread-1",
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    work: null,
    waitingForUser: false,
    runningTurnId: null,
    ...overrides,
  };
}

function cachedThreadListItem(queryClient: QueryClient): ThreadListItem {
  const item = queryClient.getQueryData<ThreadListItem[]>(
    projectQueryKeys.threads(PROJECT_ID),
  )?.[0];
  if (!item) throw new Error("Expected cached thread list item");
  return item;
}

function block(sequence: number, text: string, status: "complete" | "partial" = "complete") {
  return {
    id: `block-${sequence}-${text}`,
    turnId: "turn-1",
    responseId: null,
    blockType: "text",
    sequence,
    textContent: text,
    content: { text },
    provider: null,
    providerData: null,
    executionSide: "server",
    status,
    collapsedContent: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  } satisfies Block;
}

describe("unified-block store actions", () => {
  it("ensureAssistantTurn creates one streaming assistant turn and records running metadata", () => {
    const store = makeStore();

    store.getState().ensureAssistantTurn("thread-1", "turn-1");
    store.getState().ensureAssistantTurn("thread-1", "turn-1");

    const turns = store.getState().turns("thread-1");
    expect(turns).toHaveLength(1);
    expect(turns?.[0]).toMatchObject({
      id: "turn-1",
      threadId: "thread-1",
      role: "assistant",
      status: "streaming",
      blocks: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(store.getState().liveMeta["thread-1"]).toEqual({
      eventsApplied: 0,
      runningTurnId: "turn-1",
    });
  });

  it("ensureAssistantTurn can seed createdAt and prevTurnId without duplicating existing turns", () => {
    const store = makeStore();

    store.getState().ensureAssistantTurn("thread-1", "turn-1", {
      createdAt: "2026-02-01T00:00:00.000Z",
      prevTurnId: "turn-user",
    });

    expect(store.getState().turns("thread-1")?.[0]).toMatchObject({
      createdAt: "2026-02-01T00:00:00.000Z",
      prevTurnId: "turn-user",
    });
  });

  it("ensureAssistantTurn does not treat an existing non-assistant turn as running", () => {
    const store = makeStore();
    store.getState().ensureAssistantTurn("thread-1", "turn-running");
    const userTurn = store.getState().appendUserTurn("thread-1", "hello");
    const liveMetaBefore = store.getState().liveMeta["thread-1"];

    store.getState().ensureAssistantTurn("thread-1", userTurn.id);

    expect(store.getState().liveMeta["thread-1"]).toEqual(liveMetaBefore);
    expect(
      store
        .getState()
        .turns("thread-1")
        ?.find((turn) => turn.id === userTurn.id)?.role,
    ).toBe("user");
  });

  it("upsertAssistantBlock inserts and replaces by block sequence in sequence order", () => {
    const store = makeStore();
    store.getState().ensureAssistantTurn("thread-1", "turn-1");

    store.getState().upsertAssistantBlock("thread-1", "turn-1", block(2, "tail"));
    store.getState().upsertAssistantBlock("thread-1", "turn-1", block(0, "head"));
    store.getState().upsertAssistantBlock("thread-1", "turn-1", block(2, "tail-replaced"));

    expect(
      store
        .getState()
        .turns("thread-1")?.[0]
        ?.blocks.map((storedBlock) => [storedBlock.sequence, storedBlock.textContent]),
    ).toEqual([
      [0, "head"],
      [2, "tail-replaced"],
    ]);
  });

  it("patchTurnStatus patches terminal fields and clears metadata only for the running turn", () => {
    const store = makeStore();
    store.getState().ensureAssistantTurn("thread-1", "turn-1");
    store.getState().upsertAssistantBlock("thread-1", "turn-1", block(0, "partial", "partial"));

    store.getState().patchTurnStatus("thread-1", "turn-1", "complete", {
      completedAt: "2026-01-01T00:01:00.000Z",
      finishReason: "end_turn",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalCostUsd: "0",
        responseCount: 1,
      },
    });

    expect(store.getState().turns("thread-1")?.[0]).toMatchObject({
      status: "complete",
      completedAt: "2026-01-01T00:01:00.000Z",
      finishReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 2, totalCostUsd: "0", responseCount: 1 },
    });
    expect(store.getState().liveMeta["thread-1"]).toEqual({
      eventsApplied: 0,
      runningTurnId: null,
    });
  });

  it("patches project thread-list lifecycle through checkpoint resolve", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(projectQueryKeys.threads(PROJECT_ID), [threadListItem()]);
    const store = createThreadStore({
      now: Date.parse("2026-01-01T00:00:00.000Z"),
      threadCache: createThreadCache(queryClient),
    });

    store.getState().ensureAssistantTurn("thread-1", "turn-1");
    expect(cachedThreadListItem(queryClient)).toMatchObject({
      runningTurnId: "turn-1",
      waitingForUser: false,
    });
    expect(lifecycleFor(cachedThreadListItem(queryClient))).toBe("executing");

    store.getState().patchTurnStatus("thread-1", "turn-1", "waiting_checkpoint");
    expect(cachedThreadListItem(queryClient)).toMatchObject({
      runningTurnId: null,
      waitingForUser: true,
    });
    expect(lifecycleFor(cachedThreadListItem(queryClient))).toBe("waiting");

    store.getState().patchTurnStatus("thread-1", "turn-1", "streaming");
    expect(cachedThreadListItem(queryClient)).toMatchObject({
      runningTurnId: "turn-1",
      waitingForUser: false,
    });
    expect(lifecycleFor(cachedThreadListItem(queryClient))).toBe("executing");
  });

  it("patchTurnStatus ignores undefined patch fields so contract values stay JSON-stable", () => {
    const store = makeStore();
    store.getState().ensureAssistantTurn("thread-1", "turn-1");
    store.getState().patchTurnStatus("thread-1", "turn-1", "streaming", {
      completedAt: "2026-01-01T00:01:00.000Z",
      finishReason: "end_turn",
      inputTokens: 3,
    });

    const patchWithUndefined = {
      completedAt: undefined,
      finishReason: undefined,
      inputTokens: undefined,
      outputTokens: 7,
    } as unknown as TurnStatusPatch;
    store.getState().patchTurnStatus("thread-1", "turn-1", "complete", patchWithUndefined);

    const storedTurn = store.getState().turns("thread-1")?.[0];
    expect(storedTurn).toMatchObject({
      status: "complete",
      completedAt: "2026-01-01T00:01:00.000Z",
      finishReason: "end_turn",
      inputTokens: 3,
      outputTokens: 7,
    });
    expect(Object.values(storedTurn ?? {})).not.toContain(undefined);
    expect(JSON.parse(JSON.stringify(storedTurn))).toEqual(storedTurn);
  });

  it("bumpEventsApplied increments and returns the per-thread event counter", () => {
    const store = makeStore();

    expect(store.getState().bumpEventsApplied("thread-1")).toBe(1);
    expect(store.getState().bumpEventsApplied("thread-1")).toBe(2);
    expect(store.getState().liveMeta["thread-1"]?.eventsApplied).toBe(2);
  });
});
