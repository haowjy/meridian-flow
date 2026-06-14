/**
 * Orchestrator-event projector tests — regression coverage for AG-UI event
 * shape emitted from live orchestrator events. These tests protect protocol
 * bracketing/id contracts at the WS projection boundary, not durable read-model
 * persistence.
 */
import { EventType } from "@meridian/contracts/protocol";
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import {
  GOLDEN_THREAD_ID,
  GOLDEN_TOOL_ASSISTANT_TURN_ID,
  GOLDEN_TOOL_CALL_ID,
  goldenAssistantTurn,
  SIMPLE_TOOL_TURN_ORCHESTRATOR,
} from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";

import { projectOrchestratorEvents } from "./orchestrator-event-projector.js";

describe("orchestrator event projector tool calls", () => {
  it("parents tool calls to the active assistant message before activity snapshots", () => {
    const events = projectOrchestratorEvents(SIMPLE_TOOL_TURN_ORCHESTRATOR);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.TOOL_CALL_START,
          toolCallId: GOLDEN_TOOL_CALL_ID,
          parentMessageId: GOLDEN_TOOL_ASSISTANT_TURN_ID,
        }),
      ]),
    );

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_ARGS,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.RUN_FINISHED,
    ]);
  });

  it("forwards tool output deltas as custom AG-UI events", () => {
    const agui = projectOrchestratorEvents([
      {
        type: "tool.output_delta",
        toolCallId: "call-output",
        stream: "stderr",
        text: "warning\n",
      },
    ]);

    expect(agui).toEqual([
      {
        type: EventType.CUSTOM,
        name: "meridian.tool.output_delta",
        value: {
          toolCallId: "call-output",
          stream: "stderr",
          text: "warning\n",
        },
      },
    ]);
  });

  it("emits a companion error custom event for failed tool results", () => {
    // tool.result only fires mid-turn, so it must run with an active run.
    // TOOL_CALL_RESULT.messageId is the owning assistant run, not the call id.
    const turnId = "turn_tool_result_error";
    const [runStarted, ...rest] = projectOrchestratorEvents([
      { type: "turn.created", turn: goldenAssistantTurn(turnId, GOLDEN_THREAD_ID) },
      {
        type: "tool.result",
        toolCallId: "call-failed",
        output: "permission denied",
        isError: true,
      },
    ]);

    expect(runStarted.type).toBe(EventType.RUN_STARTED);
    expect(rest).toEqual([
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: turnId,
        toolCallId: "call-failed",
        content: "permission denied",
      },
      {
        type: EventType.CUSTOM,
        name: "meridian.tool.result_error",
        value: {
          toolCallId: "call-failed",
          isError: true,
        },
      },
    ]);
  });

  it("does not emit a companion error custom event for successful tool results", () => {
    const turnId = "turn_tool_result_ok";
    const [runStarted, ...rest] = projectOrchestratorEvents([
      { type: "turn.created", turn: goldenAssistantTurn(turnId, GOLDEN_THREAD_ID) },
      {
        type: "tool.result",
        toolCallId: "call-succeeded",
        output: "file contents",
      },
    ]);

    expect(runStarted.type).toBe(EventType.RUN_STARTED);
    expect(rest).toEqual([
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: turnId,
        toolCallId: "call-succeeded",
        content: "file contents",
      },
    ]);
    expect(
      rest.some(
        (event) => event.type === EventType.CUSTOM && event.name === "meridian.tool.result_error",
      ),
    ).toBe(false);
  });

  it("closes reasoning before a tool-call frontier and resumes with positional reasoning ids", () => {
    const assistantTurnId = "turn_reasoning_tool_reasoning";
    const toolCallId = "call_reasoning_frontier";
    const events: OrchestratorEvent[] = [
      {
        type: "turn.created",
        turn: goldenAssistantTurn(assistantTurnId, GOLDEN_THREAD_ID),
      },
      { type: "stream.delta", kind: "reasoning", text: "First reasoning." },
      {
        type: "stream.delta",
        kind: "tool_call",
        toolCallId,
        toolName: "read_file",
        argumentsDelta: '{"path":"/tmp/x"}',
      },
      { type: "stream.delta", kind: "reasoning", text: "Second reasoning." },
      {
        type: "turn.completed",
        turn: goldenAssistantTurn(assistantTurnId, GOLDEN_THREAD_ID, "complete"),
      },
    ];

    const agui = projectOrchestratorEvents(events);
    const reasoningStarts = agui.filter(
      (event) => event.type === EventType.REASONING_MESSAGE_START,
    );
    const reasoningIds = reasoningStarts.map((event) => event.messageId);

    expect(reasoningIds).toHaveLength(2);
    expect(new Set(reasoningIds).size).toBe(2);
    expect(reasoningIds).toEqual([`${assistantTurnId}::0`, `${assistantTurnId}::2`]);

    const eventTypes = agui.map((event) => event.type);
    expect(eventTypes).toEqual([
      EventType.RUN_STARTED,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
  });

  it("assigns distinct positional ids to multiple text segments in one turn", () => {
    const assistantTurnId = "turn_reasoning_text_tool_text";
    const toolCallId = "call_reasoning_text_tool_text";
    const events: OrchestratorEvent[] = [
      {
        type: "turn.created",
        turn: goldenAssistantTurn(assistantTurnId, GOLDEN_THREAD_ID),
      },
      { type: "stream.delta", kind: "reasoning", text: "Think first." },
      { type: "stream.delta", kind: "text", text: "First answer." },
      {
        type: "stream.delta",
        kind: "tool_call",
        toolCallId,
        toolName: "read_file",
        argumentsDelta: '{"path":"/tmp/x"}',
      },
      { type: "stream.delta", kind: "text", text: "Second answer." },
      {
        type: "turn.completed",
        turn: goldenAssistantTurn(assistantTurnId, GOLDEN_THREAD_ID, "complete"),
      },
    ];

    const agui = projectOrchestratorEvents(events);
    const textStarts = agui.filter((event) => event.type === EventType.TEXT_MESSAGE_START);
    const textIds = textStarts.map((event) => event.messageId);

    expect(textIds).toHaveLength(2);
    expect(new Set(textIds).size).toBe(2);
    expect(textIds).toEqual([`${assistantTurnId}::1`, `${assistantTurnId}::3`]);

    for (const textId of textIds) {
      const contentIds = agui
        .filter(
          (event) => event.type === EventType.TEXT_MESSAGE_CONTENT && event.messageId === textId,
        )
        .map((event) => event.messageId);
      expect(contentIds.length).toBeGreaterThan(0);
      expect(new Set(contentIds)).toEqual(new Set([textId]));
    }
  });

  it("uses the same reasoning sequence as persisted block events in a multi-segment turn", () => {
    const assistantTurnId = "turn_reasoning_text_tool";
    const toolCallId = "call_reasoning_text_tool";
    const events: OrchestratorEvent[] = [
      {
        type: "turn.created",
        turn: goldenAssistantTurn(assistantTurnId, GOLDEN_THREAD_ID),
      },
      { type: "stream.delta", kind: "reasoning", text: "Think first." },
      { type: "stream.delta", kind: "text", text: "Then answer." },
      {
        type: "stream.delta",
        kind: "tool_call",
        toolCallId,
        toolName: "read_file",
        argumentsDelta: '{"path":"/tmp/x"}',
      },
      {
        type: "model.response_received",
        response: {
          id: "response_reasoning_text_tool",
          turnId: assistantTurnId,
          sequence: 0,
          provider: "stub",
          model: "stub-model",
          priceSource: "unknown",
        },
      },
      {
        type: "block.upserted",
        block: {
          id: "block_reasoning_0",
          turnId: assistantTurnId,
          responseId: "response_reasoning_text_tool",
          blockType: "reasoning",
          sequence: 0,
          content: { text: "Think first." },
          provider: "stub",
          status: "complete",
        },
      },
      {
        type: "block.upserted",
        block: {
          id: "block_text_1",
          turnId: assistantTurnId,
          responseId: "response_reasoning_text_tool",
          blockType: "text",
          sequence: 1,
          content: "Then answer.",
          provider: "stub",
          status: "complete",
        },
      },
      {
        type: "block.upserted",
        block: {
          id: "block_tool_2",
          turnId: assistantTurnId,
          responseId: "response_reasoning_text_tool",
          blockType: "tool_use",
          sequence: 2,
          content: {
            toolCallId,
            toolName: "read_file",
            input: { path: "/tmp/x" },
          },
          provider: "stub",
          status: "complete",
        },
      },
      { type: "stream.delta", kind: "reasoning", text: "Reason after the tool frontier." },
      {
        type: "block.upserted",
        block: {
          id: "block_reasoning_3",
          turnId: assistantTurnId,
          responseId: "response_reasoning_text_tool_2",
          blockType: "reasoning",
          sequence: 3,
          content: { text: "Reason after the tool frontier." },
          provider: "stub",
          status: "complete",
        },
      },
      {
        type: "turn.completed",
        turn: goldenAssistantTurn(assistantTurnId, GOLDEN_THREAD_ID, "complete"),
      },
    ];

    const agui = projectOrchestratorEvents(events);
    const reasoningSequences = agui
      .filter((event) => event.type === EventType.REASONING_MESSAGE_START)
      .map((event) => Number(event.messageId.split("::")[1]));
    const persistedReasoningSequences = events
      .filter(
        (event): event is Extract<OrchestratorEvent, { type: "block.upserted" }> =>
          event.type === "block.upserted" && event.block.blockType === "reasoning",
      )
      .map((event) => event.block.sequence);

    expect(reasoningSequences).toEqual(persistedReasoningSequences);
    expect(agui).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.REASONING_MESSAGE_START,
          messageId: `${assistantTurnId}::0`,
        }),
        expect.objectContaining({
          type: EventType.REASONING_MESSAGE_START,
          messageId: `${assistantTurnId}::3`,
        }),
      ]),
    );
  });
});

describe("orchestrator event projector checkpoints", () => {
  it("projects custom checkpoint blocks before checkpoint lifecycle events", () => {
    const turnId = "turn_checkpoint_projected";

    const agui = projectOrchestratorEvents([
      {
        type: "block.upserted",
        block: {
          id: "block_checkpoint_7",
          turnId,
          responseId: null,
          blockType: "custom",
          sequence: 7,
          content: {
            kind: "choice",
            props: { question: "Proceed?" },
            checkpoint: { id: "checkpoint-1", timeoutMs: 270_000 },
          },
          provider: null,
          status: "complete",
        },
      },
      {
        type: "checkpoint.created",
        turnId,
        checkpointId: "checkpoint-1",
        blockSequence: 7,
        request: {
          checkpointId: "checkpoint-1",
          prompt: "Proceed?",
          artifacts: [],
          answerSchema: { type: "object", properties: { value: { type: "string" } } },
        },
      },
      {
        type: "checkpoint.resolved",
        turnId,
        checkpointId: "checkpoint-1",
        blockSequence: 7,
        value: { value: "approved" },
      },
      {
        type: "checkpoint.expired",
        turnId,
        checkpointId: "checkpoint-2",
        blockSequence: 9,
      },
    ]);

    expect(agui).toEqual([
      {
        type: EventType.CUSTOM,
        name: "meridian.block.upserted",
        value: {
          block: {
            id: "block_checkpoint_7",
            turnId,
            responseId: null,
            blockType: "custom",
            sequence: 7,
            content: {
              kind: "choice",
              props: { question: "Proceed?" },
              checkpoint: { id: "checkpoint-1", timeoutMs: 270_000 },
            },
            provider: null,
            status: "complete",
          },
        },
      },
      {
        type: EventType.CUSTOM,
        name: "meridian.checkpoint",
        value: {
          turnId,
          checkpointId: "checkpoint-1",
          blockSequence: 7,
          state: "created",
        },
      },
      {
        type: EventType.CUSTOM,
        name: "meridian.checkpoint",
        value: {
          turnId,
          checkpointId: "checkpoint-1",
          blockSequence: 7,
          state: "resolved",
          value: { value: "approved" },
          provenance: "user",
        },
      },
      {
        type: EventType.CUSTOM,
        name: "meridian.checkpoint",
        value: {
          turnId,
          checkpointId: "checkpoint-2",
          blockSequence: 9,
          state: "expired",
          value: null,
          provenance: "auto",
        },
      },
    ]);
  });

  it("does not project text or tool block upserts that already have delta streams", () => {
    const turnId = "turn_no_double_emit";

    const agui = projectOrchestratorEvents([
      {
        type: "block.upserted",
        block: {
          id: "block_text",
          turnId,
          responseId: "response_1",
          blockType: "text",
          sequence: 0,
          content: { text: "Already streamed" },
          provider: "stub",
          status: "complete",
        },
      },
      {
        type: "block.upserted",
        block: {
          id: "block_tool",
          turnId,
          responseId: "response_1",
          blockType: "tool_use",
          sequence: 1,
          content: { toolName: "read_file" },
          provider: "stub",
          status: "complete",
        },
      },
    ]);

    expect(agui).toEqual([]);
  });
});
