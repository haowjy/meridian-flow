/**
 * reduce-turn-event tests — regression coverage for mapping AG-UI events into
 * canonical ThreadStore turns. These protect live block identity, terminal
 * status mapping, and malformed reasoning resilience without a view accumulator.
 */

import { type Block, EventType } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { createThreadCache } from "@/client/stores/thread-store/thread-cache";
import { createThreadStore } from "@/client/stores/thread-store/thread-store";

import { applyAguiEventToStore } from "./reduce-turn-event";

function makeStore() {
  return createThreadStore({
    now: Date.parse("2026-01-01T00:00:00.000Z"),
    threadCache: createThreadCache(new QueryClient()),
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

function onlyToolBlock(store: ReturnType<typeof makeStore>): Block | undefined {
  return store
    .getState()
    .turns("thread_1")?.[0]
    ?.blocks.find((block) => block.blockType === "tool_use");
}

describe("applyAguiEventToStore", () => {
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
});
