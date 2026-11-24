import {
  type AGUIEvent,
  EventSchemas,
  EventType,
  MESSAGES_HANDED_BACK_EVENT,
  type MessagesHandedBackValue,
  RUN_STATE_EVENT,
  type RunStartedMeta,
  TURNS_FORGOTTEN_EVENT,
  type TurnsForgottenValue,
  WRITE_MODE_SWITCHED_EVENT,
  type WriteModeSwitchedValue,
} from "@meridian/contracts/protocol";
import {
  ASK_UPDATED_EVENT,
  type BlockUpsertedRow,
  type OrchestratorEvent,
  toolContentText,
} from "@meridian/contracts/threads";
import {
  WORK_CONTEXT_PROJECTION_EVENT,
  type WorkContextProjectionSignal,
} from "@meridian/contracts/works";

import { REPLY_FINISHED_EVENT_TYPES } from "../ports/event-journal.js";
import { WriteModeSwitchMetadataCodec } from "./turn-metadata.js";

export const PROJECTOR_RESET_EVENT_TYPES =
  REPLY_FINISHED_EVENT_TYPES satisfies readonly OrchestratorEvent["type"][];

function parseAguiEvent(input: Record<string, unknown>): AGUIEvent {
  return EventSchemas.parse(input);
}

type ProjectorState = {
  activeRunId: string | null;
  activeThreadId: string | null;
  openMessageId: string | null;
  openReasoningId: string | null;
  nextBlockSequence: number;
  startedToolCalls: Set<string>;
};

function createInitialProjectorState(): ProjectorState {
  return {
    activeRunId: null,
    activeThreadId: null,
    openMessageId: null,
    openReasoningId: null,
    nextBlockSequence: 0,
    startedToolCalls: new Set(),
  };
}

export function createOrchestratorEventProjector() {
  const state = createInitialProjectorState();

  function closeOpenTextMessage(): AGUIEvent[] {
    if (!state.openMessageId) return [];
    const messageId = state.openMessageId;
    state.openMessageId = null;
    return [
      parseAguiEvent({
        type: EventType.TEXT_MESSAGE_END,
        messageId,
      }),
    ];
  }

  function closeOpenReasoningMessage(): AGUIEvent[] {
    if (!state.openReasoningId) return [];
    const messageId = state.openReasoningId;
    state.openReasoningId = null;
    return [
      parseAguiEvent({
        type: EventType.REASONING_MESSAGE_END,
        messageId,
      }),
    ];
  }

  function closeOpenMessages(): AGUIEvent[] {
    return [...closeOpenTextMessage(), ...closeOpenReasoningMessage()];
  }

  function allocateBlockSequence(): number {
    const sequence = state.nextBlockSequence;
    state.nextBlockSequence += 1;
    return sequence;
  }

  function positionalMessageId(sequence: number): string | null {
    return state.activeRunId ? `${state.activeRunId}::${sequence}` : null;
  }

  function advancePastProjectedBlock(block: BlockUpsertedRow): void {
    if (!state.activeRunId || block.turnId !== state.activeRunId) return;
    state.nextBlockSequence = Math.max(state.nextBlockSequence, block.sequence + 1);
  }

  function finalizeRun(
    errorMessage?: string,
    settledStatus: "complete" | "awaiting_answer" | "cancelled" = "complete",
  ): AGUIEvent[] {
    const events = [...closeOpenTextMessage(), ...closeOpenReasoningMessage()];
    if (errorMessage) {
      events.push(
        parseAguiEvent({
          type: EventType.RUN_ERROR,
          message: errorMessage,
        }),
      );
    } else if (state.activeThreadId && state.activeRunId) {
      events.push(
        parseAguiEvent({
          type: EventType.RUN_FINISHED,
          threadId: state.activeThreadId,
          runId: state.activeRunId,
          ...(settledStatus === "cancelled"
            ? { result: { stopReason: "user_cancelled", turnStatus: settledStatus } }
            : settledStatus === "awaiting_answer"
              ? { result: { turnStatus: settledStatus } }
              : {}),
        }),
      );
    }
    state.activeRunId = null;
    state.activeThreadId = null;
    state.nextBlockSequence = 0;
    state.startedToolCalls.clear();
    return events;
  }

  function project(event: OrchestratorEvent): AGUIEvent[] {
    switch (event.type) {
      case "turn.created": {
        if (event.turn.role !== "assistant") {
          const switched = WriteModeSwitchMetadataCodec.safeParse(event.turn.metadata);
          if (event.turn.role !== "system" || !switched.success) return [];
          return [
            parseAguiEvent({
              type: EventType.CUSTOM,
              name: WRITE_MODE_SWITCHED_EVENT,
              value: {
                threadId: event.turn.threadId,
                mode: switched.data.mode,
                controlId: switched.data.controlMessageId,
                turnId: event.turn.id,
                prevTurnId: event.turn.prevTurnId ?? null,
                position: event.turn.position,
              } satisfies WriteModeSwitchedValue,
            }),
          ];
        }
        state.activeRunId = event.turn.id;
        state.activeThreadId = event.turn.threadId;
        state.nextBlockSequence = event.turn.blocks.length;
        return [
          parseAguiEvent({
            type: EventType.RUN_STARTED,
            threadId: event.turn.threadId,
            runId: event.turn.id,
            rawEvent: {
              writeMode: event.turn.writeMode,
            } satisfies RunStartedMeta,
          }),
        ];
      }

      case "work_context.changed":
        return [
          parseAguiEvent({
            type: EventType.CUSTOM,
            name: WORK_CONTEXT_PROJECTION_EVENT,
            value: {
              threadId: event.threadId,
              projectId: event.projectId,
              scope: event.scope,
            } satisfies WorkContextProjectionSignal,
          }),
        ];

      case "stream.delta": {
        if (event.kind === "text" && event.text) {
          const events: AGUIEvent[] = closeOpenReasoningMessage();
          if (!state.openMessageId) {
            const messageId = positionalMessageId(allocateBlockSequence());
            if (!messageId) return events;
            state.openMessageId = messageId;
            events.push(
              parseAguiEvent({
                type: EventType.TEXT_MESSAGE_START,
                messageId,
                role: "assistant",
              }),
            );
          }
          events.push(
            parseAguiEvent({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: state.openMessageId,
              delta: event.text,
            }),
          );
          return events;
        }

        if (event.kind === "reasoning" && event.text) {
          const events: AGUIEvent[] = closeOpenTextMessage();
          if (!state.openReasoningId) {
            const messageId = positionalMessageId(allocateBlockSequence());
            if (!messageId) return events;
            state.openReasoningId = messageId;
            events.push(
              parseAguiEvent({
                type: EventType.REASONING_MESSAGE_START,
                messageId,
                role: "reasoning",
              }),
            );
          }
          events.push(
            parseAguiEvent({
              type: EventType.REASONING_MESSAGE_CONTENT,
              messageId: state.openReasoningId,
              delta: event.text,
            }),
          );
          return events;
        }

        if (event.kind === "tool_call" && event.toolCallId) {
          const events: AGUIEvent[] = closeOpenMessages();
          if (!state.startedToolCalls.has(event.toolCallId)) {
            state.startedToolCalls.add(event.toolCallId);
            allocateBlockSequence();
            events.push(
              parseAguiEvent({
                type: EventType.TOOL_CALL_START,
                toolCallId: event.toolCallId,
                toolCallName: event.toolName ?? "tool",
                ...(state.activeRunId ? { parentMessageId: state.activeRunId } : {}),
              }),
            );
          }
          if (event.argumentsDelta) {
            events.push(
              parseAguiEvent({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: event.toolCallId,
                delta: event.argumentsDelta,
              }),
            );
          }
          return events;
        }

        return [];
      }

      case "block.updated":
        if (event.block.blockType !== "custom") return [];
        return [
          parseAguiEvent({
            type: EventType.CUSTOM,
            name: "meridian.block.upserted",
            value: { block: event.block },
          }),
        ];

      case "model.response_received":
        return event.response.turnId === state.activeRunId ? closeOpenMessages() : [];

      case "block.upserted": {
        advancePastProjectedBlock(event.block);
        if (event.block.blockType !== "custom") return [];

        const events: AGUIEvent[] = closeOpenMessages();
        events.push(
          parseAguiEvent({
            type: EventType.CUSTOM,
            name: "meridian.block.upserted",
            value: {
              block: event.block,
            },
          }),
        );
        return events;
      }

      case "tool.executing":
        return [
          parseAguiEvent({
            type: EventType.ACTIVITY_SNAPSHOT,
            activityType: "tool.executing",
            messageId: event.toolCallId,
            content: { toolName: event.name },
          }),
        ];

      case "tool.output_delta":
        return [
          parseAguiEvent({
            type: EventType.CUSTOM,
            name: "meridian.tool.output_delta",
            value: {
              toolCallId: event.toolCallId,
              stream: event.stream,
              text: event.text,
            },
          }),
        ];

      case "tool.connection_call":
        return [
          parseAguiEvent({
            type: EventType.CUSTOM,
            name: "meridian.tool.connection_call",
            value: {
              toolCallId: event.toolCallId,
              sequence: event.sequence,
              id: event.id,
              arguments: event.arguments,
              ...(event.call ? { call: event.call } : {}),
            },
          }),
        ];

      case "tool.result": {
        const events: AGUIEvent[] = closeOpenMessages();
        if (!state.activeRunId) return events;
        const messageId = state.activeRunId;
        if (state.startedToolCalls.has(event.toolCallId)) {
          events.push(
            parseAguiEvent({
              type: EventType.TOOL_CALL_END,
              toolCallId: event.toolCallId,
            }),
          );
        }
        events.push(
          parseAguiEvent({
            type: EventType.TOOL_CALL_RESULT,
            messageId,
            toolCallId: event.toolCallId,
            content: toolContentText(event.content),
            ...(event.result !== undefined ? { result: event.result } : {}),
            ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
          }),
        );
        if (event.isError === true) {
          events.push(
            parseAguiEvent({
              type: EventType.CUSTOM,
              name: "meridian.tool.result_error",
              value: {
                toolCallId: event.toolCallId,
                isError: true,
              },
            }),
          );
        }
        return events;
      }

      case "ask.updated":
        return [
          parseAguiEvent({
            type: EventType.CUSTOM,
            name: ASK_UPDATED_EVENT,
            value: event.ask,
          }),
        ];

      case "usage":
        return [
          parseAguiEvent({
            type: EventType.CUSTOM,
            name: "meridian.usage",
            value: {
              responseId: event.responseId,
              responseSeq: 0,
              turnId: event.turnId,
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              reasoningTokens: event.reasoningTokens ?? null,
              cacheReadTokens: event.cacheReadTokens ?? null,
              cacheWriteTokens: event.cacheWriteTokens ?? null,
              costUsd: event.costUsd,
              turnCostUsd: event.turnCostUsd,
            },
          }),
        ];

      case "permission.denied":
        return [
          parseAguiEvent({
            type: EventType.CUSTOM,
            name: "meridian.permission.denied",
            value: {
              callId: event.toolCallId,
              toolName: event.toolName,
              category: event.category,
              reason: event.reason,
              agent: "default",
            },
          }),
        ];

      case "agent.spawn":
        return [
          parseAguiEvent({
            type: EventType.CUSTOM,
            name: "meridian.agent.spawn",
            value: event,
          }),
        ];

      case "subagent.activity":
        return [
          parseAguiEvent({
            type: EventType.CUSTOM,
            name: "meridian.subagent.activity",
            value: event.activity,
          }),
        ];

      case "run_state.changed":
        return [
          parseAguiEvent({
            type: EventType.CUSTOM,
            name: RUN_STATE_EVENT,
            value: event.runState,
          }),
        ];

      case "thread.status":
        return [
          parseAguiEvent({
            type: EventType.CUSTOM,
            name: "meridian.thread.status",
            value: {
              threadId: event.threadId,
              status: event.status,
              runningTurnId: event.runningTurnId,
            },
          }),
        ];

      case "messages.handed_back":
        return [
          parseAguiEvent({
            type: EventType.CUSTOM,
            name: MESSAGES_HANDED_BACK_EVENT,
            value: { userTurnIds: event.userTurnIds } satisfies MessagesHandedBackValue,
          }),
        ];

      case "turns.forgotten":
        return [
          parseAguiEvent({
            type: EventType.CUSTOM,
            name: TURNS_FORGOTTEN_EVENT,
            value: {
              turnIds: event.turnIds,
              byTurnId: event.byTurnId,
              reason: event.reason,
            } satisfies TurnsForgottenValue,
          }),
        ];

      case "turn.completed":
        return finalizeRun(
          undefined,
          event.turn.status === "awaiting_answer" ? event.turn.status : "complete",
        );

      case "turn.cancelled":
        return finalizeRun(undefined, "cancelled");

      case "turn.error":
        return finalizeRun(event.error.message);

      default:
        return [];
    }
  }

  return { project };
}

export function projectOrchestratorEvents(events: OrchestratorEvent[]): AGUIEvent[] {
  const projector = createOrchestratorEventProjector();
  const agui: AGUIEvent[] = [];
  for (const event of events) {
    agui.push(...projector.project(event));
  }
  return agui;
}
