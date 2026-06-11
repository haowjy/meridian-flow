import { type AGUIEvent, EventSchemas, EventType } from "@meridian/contracts/protocol";
import type { OrchestratorEvent } from "@meridian/contracts/threads";

function parseAguiEvent(input: Record<string, unknown>): AGUIEvent {
  return EventSchemas.parse(input);
}

type ProjectorState = {
  activeRunId: string | null;
  activeThreadId: string | null;
  openMessageId: string | null;
  nextBlockSequence: number;
};

export function createOrchestratorEventProjector() {
  const state: ProjectorState = {
    activeRunId: null,
    activeThreadId: null,
    openMessageId: null,
    nextBlockSequence: 0,
  };

  function closeOpenTextMessage(): AGUIEvent[] {
    if (!state.openMessageId) return [];
    const messageId = state.openMessageId;
    state.openMessageId = null;
    return [parseAguiEvent({ type: EventType.TEXT_MESSAGE_END, messageId })];
  }

  function textMessageId(): string | null {
    if (!state.activeRunId) return null;
    const sequence = state.nextBlockSequence;
    state.nextBlockSequence += 1;
    return `${state.activeRunId}::${sequence}`;
  }

  return {
    project(event: OrchestratorEvent): AGUIEvent[] {
      switch (event.type) {
        case "turn.created": {
          if (event.turn.role !== "assistant") return [];
          state.activeRunId = event.turn.id;
          state.activeThreadId = event.turn.threadId;
          state.nextBlockSequence = event.turn.blocks.length;
          state.openMessageId = null;
          return [
            parseAguiEvent({
              type: EventType.RUN_STARTED,
              threadId: event.turn.threadId,
              runId: event.turn.id,
            }),
          ];
        }

        case "stream.delta": {
          if (event.kind !== "text" || !event.text) return [];
          const events: AGUIEvent[] = [];
          if (!state.openMessageId) {
            const messageId = textMessageId();
            if (!messageId) return events;
            state.openMessageId = messageId;
            events.push(
              parseAguiEvent({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" }),
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

        case "turn.completed": {
          const events = closeOpenTextMessage();
          if (state.activeThreadId && state.activeRunId) {
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
          return events;
        }

        default:
          return [];
      }
    },
  };
}
