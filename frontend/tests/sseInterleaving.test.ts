import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BlockTracker } from "@/features/threads/hooks/blockTracker";
import {
  handleTextMessageStart,
  handleTextMessageEnd,
} from "@/features/threads/hooks/sse/eventHandlers/textEventHandlers";
import {
  handleToolCallStart,
  handleToolCallArgs,
  handleToolCallEnd,
  handleToolCallResult,
} from "@/features/threads/hooks/sse/eventHandlers/toolEventHandlers";
import type {
  SSEDispatchContext,
  SSEStoreActions,
} from "@/features/threads/hooks/sse/types";
import { ToolStreamState } from "@/features/threads/stores/useToolStreamStore";
import type {
  TextMessageStartEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
} from "@/features/threads/hooks/sseEventTypes";
import { useThreadStore } from "@/core/stores/useThreadStore";

// Mock the thread store for content merging tests
vi.mock("@/core/stores/useThreadStore", () => ({
  useThreadStore: {
    getState: vi.fn(),
  },
}));

function makeCtx(tracker: BlockTracker): SSEDispatchContext {
  return {
    turnId: "turn-1",
    threadId: "thread-1",
    tracker,
    buffer: {
      append: vi.fn(),
      flush: vi.fn(),
    },
    // Keep logger minimal; handlers only call debug/warn/error.
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as SSEDispatchContext["logger"],
    ctrl: new AbortController(),
  };
}

function makeActions(partial?: Partial<SSEStoreActions>): SSEStoreActions {
  return {
    appendStreamingTextDelta: vi.fn(),
    setStreamingBlockContent: vi.fn(),
    clearStreamingStream: vi.fn(),
    refreshTurn: vi.fn().mockResolvedValue(undefined),
    setStreamingBlockInfo: vi.fn(),
    notifyStreamEnded: vi.fn(),
    updateToolState: vi.fn(),
    clearToolStates: vi.fn(),
    ...partial,
  } as unknown as SSEStoreActions;
}

describe("SSE interleaving", () => {
  it("does not clear tool state when TEXT_MESSAGE_END arrives after TOOL_CALL_START", () => {
    const tracker = new BlockTracker();
    const ctx = makeCtx(tracker);
    const actions = makeActions();

    handleTextMessageStart(
      {
        type: "TEXT_MESSAGE_START",
        messageId: "msg-1",
      } as TextMessageStartEvent,
      ctx,
      actions,
    );

    handleToolCallStart(
      {
        type: "TOOL_CALL_START",
        toolCallId: " functions.doc_tree:0 ",
        toolCallName: "doc_tree",
        parentMessageId: "msg-1",
      } as ToolCallStartEvent,
      ctx,
      actions,
    );

    // TEXT_MESSAGE_END for the prior message should not clear the current (tool_use) state.
    handleTextMessageEnd(
      { type: "TEXT_MESSAGE_END", messageId: "msg-1" } as TextMessageEndEvent,
      ctx,
      actions,
    );

    expect(tracker.getCurrentBlockType()).toBe("tool_use");
    expect(actions.setStreamingBlockInfo).not.toHaveBeenCalledWith(null, null);
  });

  it("normalizes toolCallId for correlation and marks tool complete on TOOL_CALL_RESULT", () => {
    const tracker = new BlockTracker();
    const ctx = makeCtx(tracker);
    const actions = makeActions();

    handleToolCallStart(
      {
        type: "TOOL_CALL_START",
        toolCallId: " functions.doc_tree:0 ",
        toolCallName: "doc_tree",
        parentMessageId: "msg-1",
      } as ToolCallStartEvent,
      ctx,
      actions,
    );

    // Ensure normalized ID is registered.
    expect(tracker.getToolCallBlockIndex("functions.doc_tree:0")).toBe(0);

    handleToolCallResult(
      {
        type: "TOOL_CALL_RESULT",
        messageId: "msg-1",
        toolCallId: " functions.doc_tree:0 ",
        content: JSON.stringify({
          tool_use_id: " functions.doc_tree:0 ",
          tool_name: "doc_tree",
          is_error: false,
          result: {},
        }),
      } as ToolCallResultEvent,
      ctx,
      actions,
    );

    expect(actions.setStreamingBlockContent).toHaveBeenCalledWith(
      "turn-1",
      1,
      "tool_result",
      expect.objectContaining({ tool_name: "doc_tree", is_error: false }),
    );

    expect(actions.updateToolState).toHaveBeenCalledWith(
      "functions.doc_tree:0",
      expect.objectContaining({ state: ToolStreamState.COMPLETE }),
    );
  });

  it("updates active arg streaming metadata on TOOL_CALL_ARGS without heavy parsing", () => {
    const tracker = new BlockTracker();
    const ctx = makeCtx(tracker);
    const actions = makeActions();

    handleToolCallStart(
      {
        type: "TOOL_CALL_START",
        toolCallId: " functions.doc_create:0 ",
        toolCallName: "doc_create",
        parentMessageId: "msg-1",
      } as ToolCallStartEvent,
      ctx,
      actions,
    );

    handleToolCallArgs(
      {
        type: "TOOL_CALL_ARGS",
        toolCallId: " functions.doc_create:0 ",
        delta: '{"path":"/x","content":"deep',
      } as ToolCallArgsEvent,
      ctx,
      actions,
    );

    expect(actions.updateToolState).toHaveBeenCalledWith(
      "functions.doc_create:0",
      expect.objectContaining({
        activeArgKey: "content",
        argsTotalBytes: expect.any(Number),
      }),
    );
  });
});

/**
 * Tool content merging tests (migrated from threadSSEToolUseMerge.test.ts)
 *
 * These tests verify that tool_use content is correctly merged during streaming.
 * The old buildToolUseContentFromJSONDelta() helper was replaced by direct
 * content merging in handleToolCallArgs/handleToolCallEnd.
 */
describe("tool content merging", () => {
  const mockGetState = vi.mocked(useThreadStore.getState);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  /**
   * Helper to set up store mock with expected turn/block structure.
   */
  function mockTurnWithBlock(
    turnId: string,
    blockIndex: number,
    content: Record<string, unknown>,
  ) {
    mockGetState.mockReturnValue({
      turnIds: [turnId],
      turnById: {
        [turnId]: {
          id: turnId,
          blocks: [{ sequence: blockIndex, content }],
        },
      },
    } as ReturnType<typeof useThreadStore.getState>);
  }

  it("merges input JSON into existing tool_use content preserving metadata", () => {
    const tracker = new BlockTracker();
    const ctx = makeCtx(tracker);
    const setStreamingBlockContent = vi.fn();
    const actions = makeActions({ setStreamingBlockContent });

    // Start tool call (creates skeleton block)
    handleToolCallStart(
      {
        type: "TOOL_CALL_START",
        toolCallId: "toolu_123",
        toolCallName: "doc_edit",
      } as ToolCallStartEvent,
      ctx,
      actions,
    );

    // Set up mock to return existing block content (simulating what Start created)
    mockTurnWithBlock("turn-1", 0, {
      tool_name: "doc_edit",
      tool_use_id: "toolu_123",
      input: {},
    });

    // Send args delta with complete JSON
    handleToolCallArgs(
      {
        type: "TOOL_CALL_ARGS",
        toolCallId: "toolu_123",
        delta: '{"path":"/ch01.md","command":"append"}',
      } as ToolCallArgsEvent,
      ctx,
      actions,
    );

    // Verify content was merged with metadata preserved
    expect(setStreamingBlockContent).toHaveBeenCalledWith(
      "turn-1",
      0,
      "tool_use",
      {
        tool_name: "doc_edit",
        tool_use_id: "toolu_123",
        input: { path: "/ch01.md", command: "append" },
      },
    );
  });

  it("handles undefined existing content gracefully", () => {
    const tracker = new BlockTracker();
    const ctx = makeCtx(tracker);
    const setStreamingBlockContent = vi.fn();
    const actions = makeActions({ setStreamingBlockContent });

    // Start tool call
    handleToolCallStart(
      {
        type: "TOOL_CALL_START",
        toolCallId: "toolu_456",
        toolCallName: "doc_view",
      } as ToolCallStartEvent,
      ctx,
      actions,
    );

    // Mock with undefined content (edge case)
    mockGetState.mockReturnValue({
      turnIds: ["turn-1"],
      turnById: {
        "turn-1": {
          id: "turn-1",
          blocks: [{ sequence: 0, content: undefined }],
        },
      },
    } as unknown as ReturnType<typeof useThreadStore.getState>);

    // Send args
    handleToolCallArgs(
      {
        type: "TOOL_CALL_ARGS",
        toolCallId: "toolu_456",
        delta: '{"path":"/x.md"}',
      } as ToolCallArgsEvent,
      ctx,
      actions,
    );

    // Should still work - tool_name/tool_use_id will be undefined but input is set
    expect(setStreamingBlockContent).toHaveBeenCalledWith(
      "turn-1",
      0,
      "tool_use",
      expect.objectContaining({
        input: { path: "/x.md" },
      }),
    );
  });

  it("preserves metadata on final parse in TOOL_CALL_END", () => {
    const tracker = new BlockTracker();
    const ctx = makeCtx(tracker);
    const setStreamingBlockContent = vi.fn();
    const actions = makeActions({ setStreamingBlockContent });

    // Start tool call
    handleToolCallStart(
      {
        type: "TOOL_CALL_START",
        toolCallId: "toolu_789",
        toolCallName: "doc_view",
      } as ToolCallStartEvent,
      ctx,
      actions,
    );

    // Send partial args (won't trigger parse due to incomplete JSON)
    handleToolCallArgs(
      {
        type: "TOOL_CALL_ARGS",
        toolCallId: "toolu_789",
        delta: '{"path":"/doc',
      } as ToolCallArgsEvent,
      ctx,
      actions,
    );

    // Set up mock for end handler
    mockTurnWithBlock("turn-1", 0, {
      tool_name: "doc_view",
      tool_use_id: "toolu_789",
      input: {},
    });

    // Manually append more delta to complete JSON in tracker
    handleToolCallArgs(
      {
        type: "TOOL_CALL_ARGS",
        toolCallId: "toolu_789",
        delta: '.md"}',
      } as ToolCallArgsEvent,
      ctx,
      actions,
    );

    // End the tool call - triggers final parse
    handleToolCallEnd(
      {
        type: "TOOL_CALL_END",
        toolCallId: "toolu_789",
      } as ToolCallEndEvent,
      ctx,
      actions,
    );

    // Verify final content has metadata preserved
    expect(setStreamingBlockContent).toHaveBeenLastCalledWith(
      "turn-1",
      0,
      "tool_use",
      {
        tool_name: "doc_view",
        tool_use_id: "toolu_789",
        input: { path: "/doc.md" },
      },
    );
  });

  it("handles incomplete JSON gracefully in TOOL_CALL_END", () => {
    const tracker = new BlockTracker();
    const ctx = makeCtx(tracker);
    const actions = makeActions();

    // Start tool call
    handleToolCallStart(
      {
        type: "TOOL_CALL_START",
        toolCallId: "toolu_bad",
        toolCallName: "doc_edit",
      } as ToolCallStartEvent,
      ctx,
      actions,
    );

    // Send valid partial JSON that will fail final JSON.parse in END handler
    // Note: partial-json can parse incomplete JSON like '{"path":"/doc' but
    // JSON.parse in END handler will fail on it
    handleToolCallArgs(
      {
        type: "TOOL_CALL_ARGS",
        toolCallId: "toolu_bad",
        delta: '{"path":"/incomplete',
      } as ToolCallArgsEvent,
      ctx,
      actions,
    );

    // End should not throw - gracefully handles parse error via try-catch
    expect(() => {
      handleToolCallEnd(
        {
          type: "TOOL_CALL_END",
          toolCallId: "toolu_bad",
        } as ToolCallEndEvent,
        ctx,
        actions,
      );
    }).not.toThrow();

    // Tool state should still advance to EXECUTING despite parse error
    expect(actions.updateToolState).toHaveBeenCalledWith(
      "toolu_bad",
      expect.objectContaining({ state: ToolStreamState.EXECUTING }),
    );

    // Error should be logged
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "sse:TOOL_CALL_END:final_parse_error",
      expect.any(Error),
      expect.objectContaining({ toolCallId: "toolu_bad" }),
    );
  });
});
