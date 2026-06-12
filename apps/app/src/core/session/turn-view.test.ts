// @ts-nocheck
/**
 * reduce-turn-event tests — regression coverage for mapping AG-UI events into
 * canonical ThreadStore turns. These protect live block identity, terminal
 * status mapping, and malformed reasoning resilience without a view accumulator.
 */

import { type Block, EventType, type Thread, type Turn } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { createThreadStore } from "@/client/stores/thread-store/thread-store";

import { applyAguiEventToStore } from "./reduce-turn-event";

function makeStore() {
  return createThreadStore({
    now: Date.parse("2026-01-01T00:00:00.000Z"),
    queryClient: new QueryClient(),
  });
}

function checkpointBlock({
  sequence,
  checkpointId,
}: {
  sequence: number;
  checkpointId: string;
}): Block {
  return {
    id: `block_${sequence}`,
    turnId: "turn_1",
    responseId: null,
    blockType: "custom",
    sequence,
    textContent: null,
    content: {
      kind: "choice",
      props: {
        question: "Which analysis?",
        options: [
          { value: "quick", label: "Quick" },
          { value: "full", label: "Full" },
        ],
        recommended: "quick",
        requiresHuman: false,
      },
      checkpoint: { id: checkpointId, timeoutMs: 270_000 },
      label: "Which analysis?",
    },
    provider: null,
    providerData: null,
    executionSide: "server",
    status: "complete",
    collapsedContent: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function thread(id: string): Thread {
  return {
    id,
    workbenchId: "project_1",
    workId: null,
    userId: "user_1",
    kind: "primary",
    status: "idle",
    title: "Thread",
    currentAgent: null,
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

function assistantTurnWithBlocks(id: string, blocks: Block[]): Turn {
  return {
    id,
    threadId: "thread_1",
    prevTurnId: "user_1",
    parentTurnId: "user_1",
    role: "assistant",
    status: "streaming",
    finishReason: null,
    model: null,
    provider: null,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalCostUsd: "0",
    responseCount: 0,
    usage: null,
    error: null,
    requestParams: null,
    responseMetadata: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    blocks,
    siblingIds: [],
    responses: [],
  };
}

function onlyToolBlock(store: ReturnType<typeof makeStore>): Block | undefined {
  return store
    .getState()
    .turns("thread_1")?.[0]
    ?.blocks.find((block) => block.blockType === "tool_use");
}

describe("applyAguiEventToStore", () => {
  it("maps STATE_SNAPSHOT waiting_checkpoint to a streaming turn with a state block", () => {
    const store = makeStore();

    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.STATE_SNAPSHOT,
      snapshot: {
        status: "waiting_checkpoint",
        runningTurnId: "turn_checkpoint",
      },
    });

    const turn = store.getState().turns("thread_1")?.[0];
    expect(turn).toMatchObject({
      id: "turn_checkpoint",
      status: "streaming",
    });
    expect(turn?.blocks[0]).toMatchObject({
      blockType: "state_snapshot",
      status: "complete",
    });
  });

  it("maps meridian.checkpoint lifecycle events to turn status and checkpoint block props", () => {
    const store = makeStore();

    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.RUN_STARTED,
      threadId: "thread_1",
      runId: "turn_1",
    });
    store
      .getState()
      .upsertAssistantBlock(
        "thread_1",
        "turn_1",
        checkpointBlock({ sequence: 2, checkpointId: "checkpoint_user" }),
      );

    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.CUSTOM,
      name: "meridian.checkpoint",
      value: {
        state: "created",
        turnId: "turn_1",
        checkpointId: "checkpoint_user",
        blockSequence: 2,
      },
    });

    let turn = store.getState().turns("thread_1")?.[0];
    expect(turn?.status).toBe("waiting_checkpoint");
    expect(turn?.blocks).toHaveLength(1);

    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.CUSTOM,
      name: "meridian.checkpoint",
      value: {
        state: "resolved",
        turnId: "turn_1",
        checkpointId: "checkpoint_user",
        blockSequence: 2,
        value: { value: "quick" },
        provenance: "user",
      },
    });

    turn = store.getState().turns("thread_1")?.[0];
    expect(turn?.status).toBe("streaming");
    expect(turn?.blocks).toHaveLength(1);
    expect(turn?.blocks[0]?.content).toMatchObject({
      props: {
        resolvedValue: "quick",
        answerProvenance: "user",
      },
    });

    store
      .getState()
      .upsertAssistantBlock(
        "thread_1",
        "turn_1",
        checkpointBlock({ sequence: 3, checkpointId: "checkpoint_auto" }),
      );
    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.CUSTOM,
      name: "meridian.checkpoint",
      value: {
        state: "created",
        turnId: "turn_1",
        checkpointId: "checkpoint_auto",
        blockSequence: 3,
      },
    });
    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.CUSTOM,
      name: "meridian.checkpoint",
      value: {
        state: "expired",
        turnId: "turn_1",
        checkpointId: "checkpoint_auto",
        blockSequence: 3,
        provenance: "auto",
      },
    });

    turn = store.getState().turns("thread_1")?.[0];
    expect(turn?.status).toBe("streaming");
    expect(turn?.blocks).toHaveLength(2);
    expect(turn?.blocks[1]?.content).toMatchObject({
      props: {
        resolvedValue: "__expired__",
        answerProvenance: "auto",
      },
    });
    expect(turn?.blocks.map((block) => block.id)).not.toContain("turn_1_custom_2");
    expect(turn?.blocks.every((block) => block.content && typeof block.content === "object")).toBe(
      true,
    );
  });

  it("applies live custom block upserts before checkpoint.created marks the turn waiting", () => {
    const store = makeStore();

    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.RUN_STARTED,
      threadId: "thread_1",
      runId: "turn_1",
    });
    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.CUSTOM,
      name: "meridian.block.upserted",
      value: {
        block: {
          id: "block_checkpoint_live",
          turnId: "turn_1",
          responseId: null,
          blockType: "custom",
          sequence: 4,
          content: {
            kind: "choice",
            props: { question: "Proceed?", recommended: "yes" },
            checkpoint: { id: "checkpoint_live", timeoutMs: 270_000 },
            label: "Proceed?",
          },
          provider: null,
          status: "complete",
        },
      },
    });
    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.CUSTOM,
      name: "meridian.checkpoint",
      value: {
        state: "created",
        turnId: "turn_1",
        checkpointId: "checkpoint_live",
        blockSequence: 4,
      },
    });

    const turn = store.getState().turns("thread_1")?.[0];
    expect(turn?.status).toBe("waiting_checkpoint");
    expect(turn?.blocks).toEqual([
      expect.objectContaining({
        id: "block_checkpoint_live",
        blockType: "custom",
        sequence: 4,
        content: expect.objectContaining({
          checkpoint: { id: "checkpoint_live", timeoutMs: 270_000 },
        }),
      }),
    ]);
  });

  it("buffers checkpoint resolution by checkpoint id until an out-of-order block arrives", () => {
    const store = makeStore();

    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.RUN_STARTED,
      threadId: "thread_1",
      runId: "turn_1",
    });
    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.CUSTOM,
      name: "meridian.checkpoint",
      value: {
        state: "resolved",
        turnId: "turn_1",
        checkpointId: "checkpoint_late_block",
        value: { value: "full" },
        provenance: "user",
      },
    });

    let turn = store.getState().turns("thread_1")?.[0];
    expect(turn?.status).toBe("streaming");
    expect(turn?.blocks).toEqual([]);

    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.CUSTOM,
      name: "meridian.block.upserted",
      value: {
        block: {
          id: "block_checkpoint_late",
          turnId: "turn_1",
          responseId: null,
          blockType: "custom",
          sequence: 8,
          content: {
            kind: "choice",
            props: { question: "Which analysis?" },
            checkpoint: { id: "checkpoint_late_block", timeoutMs: 270_000 },
          },
          provider: null,
          status: "complete",
        },
      },
    });

    turn = store.getState().turns("thread_1")?.[0];
    expect(turn?.blocks[0]).toMatchObject({
      id: "block_checkpoint_late",
      sequence: 8,
      content: {
        props: {
          resolvedValue: "full",
          answerProvenance: "user",
        },
      },
    });
  });

  it("drops orphaned checkpoint patches when an HTTP snapshot replaces the thread", () => {
    const store = makeStore();

    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.RUN_STARTED,
      threadId: "thread_1",
      runId: "turn_1",
    });
    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.CUSTOM,
      name: "meridian.checkpoint",
      value: {
        state: "resolved",
        turnId: "turn_1",
        checkpointId: "checkpoint_orphaned",
        value: { value: "full" },
        provenance: "user",
      },
    });

    store.getState().applyThreadSnapshot(thread("thread_1"), [], {
      waitingForUser: false,
      runningTurnId: null,
    });

    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.CUSTOM,
      name: "meridian.block.upserted",
      value: {
        block: {
          id: "block_checkpoint_after_snapshot",
          turnId: "turn_1",
          responseId: null,
          blockType: "custom",
          sequence: 8,
          content: {
            kind: "choice",
            props: {
              question: "Which analysis?",
              options: [{ value: "full", label: "Full" }],
              recommended: null,
              requiresHuman: false,
            },
            checkpoint: { id: "checkpoint_orphaned", timeoutMs: 270_000 },
          },
          provider: null,
          status: "complete",
        },
      },
    });

    const turn = store.getState().turns("thread_1")?.[0];
    expect(turn?.blocks[0]?.content).toMatchObject({
      props: {
        question: "Which analysis?",
      },
    });
    expect(turn?.blocks[0]?.content).not.toMatchObject({
      props: {
        resolvedValue: "full",
        answerProvenance: "user",
      },
    });
  });

  it("renders user_cancelled stop reasons as cancelled", () => {
    const store = makeStore();

    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.RUN_STARTED,
      threadId: "thread_1",
      runId: "turn_1",
    });
    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.RUN_FINISHED,
      threadId: "thread_1",
      runId: "turn_1",
      result: {
        status: "cancelled",
        stopReason: "user_cancelled",
      },
    });

    expect(store.getState().turns("thread_1")?.[0]?.status).toBe("cancelled");
  });

  it("preserves positional reasoning identity and sequence", () => {
    const store = makeStore();
    const reasoningId = "turn_1::3";
    const events = [
      { type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" },
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: reasoningId,
        role: "reasoning",
      },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: reasoningId,
        delta: "First reasoning.",
      },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call_1",
        toolCallName: "read_file",
      },
      { type: EventType.RUN_FINISHED, threadId: "thread_1", runId: "turn_1" },
    ] as const;

    for (const event of events) {
      applyAguiEventToStore(store.getState(), "thread_1", event);
    }

    const reasoningBlock = store
      .getState()
      .turns("thread_1")?.[0]
      ?.blocks.find((block) => block.blockType === "reasoning");

    expect(reasoningBlock).toMatchObject({
      id: reasoningId,
      turnId: "turn_1",
      sequence: 3,
      textContent: "First reasoning.",
      status: "complete",
    });
  });

  it("drops legacy synthetic reasoning ids without wedging the live turn", () => {
    const store = makeStore();

    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.RUN_STARTED,
      threadId: "thread_1",
      runId: "turn_1",
    });
    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.REASONING_MESSAGE_START,
      messageId: "turn_1_reasoning",
      role: "reasoning",
    });

    const turn = store.getState().turns("thread_1")?.[0];
    expect(turn).toMatchObject({ status: "streaming", id: "turn_1" });
    expect(turn?.blocks).toEqual([]);
    expect(store.getState().liveMeta.thread_1?.eventsApplied).toBe(2);
  });

  it("concatenates streamed tool arg fragments into one input buffer", () => {
    const store = makeStore();

    for (const event of [
      { type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "t1",
        toolCallName: "read",
      },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "t1", delta: '{"path":' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "t1", delta: '"a"}' },
    ] as const) {
      applyAguiEventToStore(store.getState(), "thread_1", event);
    }

    const toolBlock = onlyToolBlock(store);
    expect(toolBlock?.status).toBe("partial");
    expect(toolBlock?.content).toMatchObject({
      toolCallId: "t1",
      toolName: "read",
      input: '{"path":"a"}',
    });
  });

  it("creates a partial tool block when args arrive before tool start", () => {
    const store = makeStore();

    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.RUN_STARTED,
      threadId: "thread_1",
      runId: "turn_1",
    });
    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "t1",
      delta: '{"path":"a"}',
    });

    const toolBlock = onlyToolBlock(store);
    expect(toolBlock).toMatchObject({
      id: "tool-t1",
      status: "partial",
    });
    expect(toolBlock?.content).toMatchObject({
      toolCallId: "t1",
      toolName: "tool",
      input: '{"path":"a"}',
    });
  });

  it("preserves streamed tool args through tool end and result", () => {
    const store = makeStore();

    for (const event of [
      { type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "t1",
        toolCallName: "read",
      },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "t1", delta: '{"path":"a"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: "t1" },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "turn_1",
        toolCallId: "t1",
        content: "file contents",
      },
    ] as const) {
      applyAguiEventToStore(store.getState(), "thread_1", event);
    }

    const toolBlock = onlyToolBlock(store);
    expect(toolBlock?.status).toBe("complete");
    expect(toolBlock?.content).toMatchObject({
      toolCallId: "t1",
      toolName: "read",
      input: '{"path":"a"}',
      output: "file contents",
    });
  });

  it("marks a completed tool block as errored when meridian.tool.result_error follows the result", () => {
    const store = makeStore();

    for (const event of [
      { type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "t1",
        toolCallName: "read",
      },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "turn_1",
        toolCallId: "t1",
        content: "permission denied",
      },
      {
        type: EventType.CUSTOM,
        name: "meridian.tool.result_error",
        value: { toolCallId: "t1", isError: true },
      },
    ] as const) {
      applyAguiEventToStore(store.getState(), "thread_1", event);
    }

    const toolBlock = onlyToolBlock(store);
    expect(toolBlock?.status).toBe("complete");
    expect(toolBlock?.content).toMatchObject({
      toolCallId: "t1",
      toolName: "read",
      output: "permission denied",
      isError: true,
    });
  });

  it("preserves meridian.tool.result_error when it arrives before TOOL_CALL_RESULT", () => {
    const store = makeStore();

    for (const event of [
      { type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "t1",
        toolCallName: "read",
      },
      {
        type: EventType.CUSTOM,
        name: "meridian.tool.result_error",
        value: { toolCallId: "t1", isError: true },
      },
    ] as const) {
      applyAguiEventToStore(store.getState(), "thread_1", event);
    }

    expect(onlyToolBlock(store)).toMatchObject({
      status: "partial",
      content: { isError: true },
    });

    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "turn_1",
      toolCallId: "t1",
      content: "permission denied",
    });

    const toolBlock = onlyToolBlock(store);
    expect(toolBlock?.status).toBe("complete");
    expect(toolBlock?.content).toMatchObject({
      toolCallId: "t1",
      output: "permission denied",
      isError: true,
    });
  });

  it("does not regress a complete tool block when meridian.tool.result_error arrives later", () => {
    const store = makeStore();

    for (const event of [
      { type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "turn_1",
        toolCallId: "t1",
        content: "permission denied",
      },
      {
        type: EventType.CUSTOM,
        name: "meridian.tool.result_error",
        value: { toolCallId: "t1", isError: true },
      },
    ] as const) {
      applyAguiEventToStore(store.getState(), "thread_1", event);
    }

    const toolBlock = onlyToolBlock(store);
    expect(toolBlock?.status).toBe("complete");
    expect(toolBlock?.content).toMatchObject({
      toolCallId: "t1",
      output: "permission denied",
      isError: true,
    });
  });

  it("ignores meridian.tool.result_error for an unknown toolCallId", () => {
    const store = makeStore();

    for (const event of [
      { type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "t1",
        toolCallName: "read",
      },
      {
        type: EventType.CUSTOM,
        name: "meridian.tool.result_error",
        value: { toolCallId: "ghost", isError: true },
      },
    ] as const) {
      applyAguiEventToStore(store.getState(), "thread_1", event);
    }

    const toolBlock = onlyToolBlock(store);
    expect(toolBlock?.content).toMatchObject({
      toolCallId: "t1",
      isError: false,
    });
  });

  it("drops malformed meridian.tool.result_error payloads without changing the tool block", () => {
    const store = makeStore();

    for (const event of [
      { type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "t1",
        toolCallName: "read",
      },
      // isError must be the literal true marker; false is not a failure event.
      {
        type: EventType.CUSTOM,
        name: "meridian.tool.result_error",
        value: { toolCallId: "t1", isError: false },
      },
      // missing toolCallId
      {
        type: EventType.CUSTOM,
        name: "meridian.tool.result_error",
        value: { isError: true },
      },
      // non-object value
      {
        type: EventType.CUSTOM,
        name: "meridian.tool.result_error",
        value: "not an object",
      },
    ] as const) {
      applyAguiEventToStore(store.getState(), "thread_1", event);
    }

    const toolBlock = onlyToolBlock(store);
    expect(toolBlock?.status).toBe("partial");
    expect(toolBlock?.content).toMatchObject({
      toolCallId: "t1",
      isError: false,
    });
  });

  it("accumulates text content into one partial block and completes it on end", () => {
    const store = makeStore();

    for (const event of [
      { type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "msg_1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg_1", delta: "Hello" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg_1", delta: " world" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg_1" },
    ] as const) {
      applyAguiEventToStore(store.getState(), "thread_1", event);
    }

    expect(store.getState().turns("thread_1")?.[0]?.blocks[0]).toMatchObject({
      id: "msg_1",
      blockType: "text",
      textContent: "Hello world",
      status: "complete",
    });
  });

  it("produces two fully-populated text blocks for text → tool → text in one turn", () => {
    const store = makeStore();

    for (const event of [
      { type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "turn_1::0", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "turn_1::0", delta: "Before tool." },
      { type: EventType.TEXT_MESSAGE_END, messageId: "turn_1::0" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "t1",
        toolCallName: "read",
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "t1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "turn_1::2", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "turn_1::2", delta: "After tool." },
      { type: EventType.TEXT_MESSAGE_END, messageId: "turn_1::2" },
    ] as const) {
      applyAguiEventToStore(store.getState(), "thread_1", event);
    }

    const blocks = store.getState().turns("thread_1")?.[0]?.blocks ?? [];
    const textBlocks = blocks.filter((block) => block.blockType === "text");
    expect(textBlocks).toHaveLength(2);
    expect(textBlocks[0]).toMatchObject({
      id: "turn_1::0",
      textContent: "Before tool.",
      status: "complete",
    });
    expect(textBlocks[1]).toMatchObject({
      id: "turn_1::2",
      textContent: "After tool.",
      status: "complete",
    });
  });

  it("routes text deltas to the most-recent block when duplicate messageIds exist", () => {
    const store = makeStore();
    const duplicateId = "turn_1";

    for (const event of [
      { type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: duplicateId, role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: duplicateId, delta: "first" },
      { type: EventType.TEXT_MESSAGE_END, messageId: duplicateId },
      { type: EventType.TEXT_MESSAGE_START, messageId: duplicateId, role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: duplicateId, delta: "second" },
      { type: EventType.TEXT_MESSAGE_END, messageId: duplicateId },
    ] as const) {
      applyAguiEventToStore(store.getState(), "thread_1", event);
    }

    const textBlocks =
      store
        .getState()
        .turns("thread_1")?.[0]
        ?.blocks.filter((block) => block.blockType === "text") ?? [];
    expect(textBlocks).toHaveLength(2);
    expect(textBlocks[0]).toMatchObject({
      id: duplicateId,
      textContent: "first",
      status: "complete",
    });
    expect(textBlocks[1]).toMatchObject({
      id: duplicateId,
      textContent: "second",
      status: "complete",
    });
  });

  it("appends replayed deltas after materialized snapshot blocks without duplicating text", () => {
    const store = makeStore();
    const materializedBlock: Block = {
      id: "block_materialized",
      turnId: "turn_1",
      responseId: "response_1",
      blockType: "text",
      sequence: 0,
      textContent: "First sentence.",
      content: "First sentence.",
      provider: null,
      providerData: null,
      executionSide: "server",
      status: "complete",
      collapsedContent: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    store
      .getState()
      .applyThreadSnapshot(
        thread("thread_1"),
        [assistantTurnWithBlocks("turn_1", [materializedBlock])],
        {
          runningTurnId: "turn_1",
          waitingForUser: false,
        },
      );

    // Catch-up from the projection watermark can replay CONTENT without the
    // earlier START for an already-materialized text block. The reducer must
    // make a new partial block for only the unmaterialized tail. The tail
    // segment carries the real positional wire id (`${turnId}::${sequence}`),
    // here sequence 1 since the materialized block is sequence 0.
    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "turn_1::1",
      delta: "Second sentence",
    });

    const blocks = store.getState().turns("thread_1")?.[0]?.blocks ?? [];
    expect(blocks.map((block) => block.textContent)).toEqual([
      "First sentence.",
      "Second sentence",
    ]);
    // The replayed tail block is keyed by its positional message id, distinct
    // from the materialized snapshot block — no merge onto the wrong block.
    expect(blocks[1]?.id).toBe("turn_1::1");
  });

  it("accumulates meridian.tool.output_delta chunks into streamedOutput in arrival order", () => {
    const store = makeStore();

    for (const event of [
      { type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "t1",
        toolCallName: "bash",
      },
      {
        type: EventType.CUSTOM,
        name: "meridian.tool.output_delta",
        value: { toolCallId: "t1", stream: "stdout", text: "line one\n" },
      },
      {
        type: EventType.CUSTOM,
        name: "meridian.tool.output_delta",
        value: { toolCallId: "t1", stream: "stderr", text: "warn: thing\n" },
      },
      {
        type: EventType.CUSTOM,
        name: "meridian.tool.output_delta",
        value: { toolCallId: "t1", stream: "stdout", text: "line two\n" },
      },
    ] as const) {
      applyAguiEventToStore(store.getState(), "thread_1", event);
    }

    const toolBlock = onlyToolBlock(store);
    expect(toolBlock?.status).toBe("partial");
    expect(toolBlock?.content).toMatchObject({
      toolCallId: "t1",
      streamedOutput: "line one\nwarn: thing\nline two\n",
    });
  });

  it("preserves streamedOutput through TOOL_CALL_RESULT so the live log survives completion", () => {
    const store = makeStore();

    for (const event of [
      { type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "t1",
        toolCallName: "bash",
      },
      {
        type: EventType.CUSTOM,
        name: "meridian.tool.output_delta",
        value: { toolCallId: "t1", stream: "stdout", text: "hello\n" },
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "t1" },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "turn_1",
        toolCallId: "t1",
        content: "structured result",
      },
    ] as const) {
      applyAguiEventToStore(store.getState(), "thread_1", event);
    }

    const toolBlock = onlyToolBlock(store);
    expect(toolBlock?.status).toBe("complete");
    expect(toolBlock?.content).toMatchObject({
      streamedOutput: "hello\n",
      output: "structured result",
    });
  });

  it("ignores meridian.tool.output_delta for an unknown toolCallId (race against TOOL_CALL_START)", () => {
    const store = makeStore();

    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.RUN_STARTED,
      threadId: "thread_1",
      runId: "turn_1",
    });
    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.CUSTOM,
      name: "meridian.tool.output_delta",
      value: { toolCallId: "ghost", stream: "stdout", text: "should not land\n" },
    });

    const turn = store.getState().turns("thread_1")?.[0];
    expect(turn?.blocks ?? []).toEqual([]);
  });

  it("drops malformed meridian.tool.output_delta payloads without crashing or creating blocks", () => {
    const store = makeStore();

    for (const event of [
      { type: EventType.RUN_STARTED, threadId: "thread_1", runId: "turn_1" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "t1",
        toolCallName: "bash",
      },
      // missing text
      {
        type: EventType.CUSTOM,
        name: "meridian.tool.output_delta",
        value: { toolCallId: "t1", stream: "stdout" },
      },
      // bad stream literal
      {
        type: EventType.CUSTOM,
        name: "meridian.tool.output_delta",
        value: { toolCallId: "t1", stream: "stdin", text: "x" },
      },
      // empty toolCallId
      {
        type: EventType.CUSTOM,
        name: "meridian.tool.output_delta",
        value: { toolCallId: "", stream: "stdout", text: "x" },
      },
      // non-object value
      {
        type: EventType.CUSTOM,
        name: "meridian.tool.output_delta",
        value: "not an object",
      },
    ] as const) {
      applyAguiEventToStore(store.getState(), "thread_1", event);
    }

    const toolBlock = onlyToolBlock(store);
    expect(toolBlock?.content).toMatchObject({ streamedOutput: null });
  });
});
