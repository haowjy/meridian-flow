/**
 * Orchestrator-event projector: a stateful translator from internal
 * OrchestratorEvents into the AG-UI event protocol, tracking open run/message/
 * reasoning ids so emitted events are well-formed. Text and reasoning message ids
 * use Route A positional identity (`${turnId}::${sequence}`): sequence starts from
 * the assistant turn's block count at run start and advances as stream frontiers
 * begin in the same order persisted block.upserted rows later confirm. The
 * single source of the orchestrator->AG-UI mapping; depends only on the protocol
 * contracts.
 */
import type { CheckpointAnswerProvenance } from "@meridian/contracts/components";
import { type AGUIEvent, EventSchemas, EventType } from "@meridian/contracts/protocol";
import type { BlockUpsertedRow, OrchestratorEvent } from "@meridian/contracts/threads";

const USER_CHECKPOINT_PROVENANCE: CheckpointAnswerProvenance = "user";

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

  // Text and reasoning share nextBlockSequence so ::ids never collide within a turn.
  function positionalMessageId(sequence: number): string | null {
    return state.activeRunId ? `${state.activeRunId}::${sequence}` : null;
  }

  function advancePastProjectedBlock(block: BlockUpsertedRow): void {
    if (!state.activeRunId || block.turnId !== state.activeRunId) return;
    state.nextBlockSequence = Math.max(state.nextBlockSequence, block.sequence + 1);
  }

  function finalizeRun(errorMessage?: string): AGUIEvent[] {
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
        if (event.turn.role !== "assistant") return [];
        state.activeRunId = event.turn.id;
        state.activeThreadId = event.turn.threadId;
        state.nextBlockSequence = event.turn.blocks.length;
        return [
          parseAguiEvent({
            type: EventType.RUN_STARTED,
            threadId: event.turn.threadId,
            runId: event.turn.id,
          }),
        ];
      }

      case "stream.delta": {
        if (event.kind === "text" && event.text) {
          const events: AGUIEvent[] = closeOpenReasoningMessage();
          if (!state.openMessageId) {
            // Encode block sequence in the id so each text segment across tool/reasoning
            // frontiers is uniquely addressable by the client reducer.
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

      case "block.upserted": {
        advancePastProjectedBlock(event.block);
        if (event.block.blockType !== "custom") return [];

        // Text/reasoning/tool blocks already have delta-based AG-UI paths.
        // Custom component blocks do not, so projecting only this type avoids
        // both the checkpoint UI gap and double-emitting streamed blocks.
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

      case "tool.result": {
        // TOOL_CALL_RESULT.messageId is the owning assistant run, not the tool
        // call. tool.result only fires mid-turn, so activeRunId is set; if it
        // is somehow absent the event has no run to attach to — drop it (like
        // the text/reasoning branches) rather than emit under a bogus id.
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
            content: typeof event.output === "string" ? event.output : JSON.stringify(event.output),
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

      case "checkpoint.created":
        return [
          parseAguiEvent({
            type: EventType.CUSTOM,
            name: "meridian.checkpoint",
            value: {
              turnId: event.turnId,
              checkpointId: event.checkpointId,
              blockSequence: event.blockSequence,
              state: "created",
            },
          }),
        ];

      case "checkpoint.resolved":
        return [
          parseAguiEvent({
            type: EventType.CUSTOM,
            name: "meridian.checkpoint",
            value: {
              turnId: event.turnId,
              checkpointId: event.checkpointId,
              blockSequence: event.blockSequence,
              state: "resolved",
              value: event.value,
              provenance: USER_CHECKPOINT_PROVENANCE,
            },
          }),
        ];

      case "checkpoint.expired":
        return [
          parseAguiEvent({
            type: EventType.CUSTOM,
            name: "meridian.checkpoint",
            value: {
              turnId: event.turnId,
              checkpointId: event.checkpointId,
              blockSequence: event.blockSequence,
              state: "expired",
              value: null,
              provenance: "auto",
            },
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

      case "turn.completed":
        return finalizeRun();

      case "turn.cancelled":
        return finalizeRun();

      case "turn.error":
        return finalizeRun(event.error.message);

      default:
        return [];
    }
  }

  return { project };
}

/** Project a journal/orchestrator event stream to AG-UI events (one projector state). */
export function projectOrchestratorEvents(events: OrchestratorEvent[]): AGUIEvent[] {
  const projector = createOrchestratorEventProjector();
  const agui: AGUIEvent[] = [];
  for (const event of events) {
    agui.push(...projector.project(event));
  }
  return agui;
}
