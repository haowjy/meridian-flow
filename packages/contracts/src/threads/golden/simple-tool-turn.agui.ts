/**
 * Purpose: Defines the expected AG-UI event stream for the simple tool-call golden turn.
 * Why independent: The fixture is a shared protocol contract example for tool-call projection, not tool execution logic.
 */
import { type AGUIEvent, EventType } from "../../protocol/index.js";

import { GOLDEN_THREAD_ID, GOLDEN_USER_TURN_ID } from "./simple-text-turn.js";
import { GOLDEN_TOOL_ASSISTANT_TURN_ID, GOLDEN_TOOL_CALL_ID } from "./simple-tool-turn.js";
import { GOLDEN_EXECUTION_ID } from "./turn-fixture.js";

/** Golden AG-UI stream for {@link SIMPLE_TOOL_TURN_ORCHESTRATOR} (server projector output). */
export const SIMPLE_TOOL_TURN_AGUI: AGUIEvent[] = [
  {
    type: EventType.RUN_STARTED,
    threadId: GOLDEN_THREAD_ID,
    runId: GOLDEN_TOOL_ASSISTANT_TURN_ID,
    rawEvent: {
      writeMode: null,
      executionId: GOLDEN_EXECUTION_ID,
      reservedForUserTurnIds: [GOLDEN_USER_TURN_ID],
      position: 1,
    },
  },
  {
    type: EventType.TOOL_CALL_START,
    toolCallId: GOLDEN_TOOL_CALL_ID,
    toolCallName: "read_file",
    parentMessageId: GOLDEN_TOOL_ASSISTANT_TURN_ID,
  },
  {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: GOLDEN_TOOL_CALL_ID,
    delta: '{"path":',
  },
  {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: GOLDEN_TOOL_CALL_ID,
    delta: '"/tmp/x"}',
  },
  {
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId: GOLDEN_TOOL_CALL_ID,
    activityType: "tool.executing",
    content: { toolName: "read_file" },
    replace: true,
  },
  {
    type: EventType.TOOL_CALL_END,
    toolCallId: GOLDEN_TOOL_CALL_ID,
  },
  {
    type: EventType.TOOL_CALL_RESULT,
    messageId: GOLDEN_TOOL_ASSISTANT_TURN_ID,
    toolCallId: GOLDEN_TOOL_CALL_ID,
    content: "file contents",
  },
  {
    type: EventType.RUN_FINISHED,
    threadId: GOLDEN_THREAD_ID,
    runId: GOLDEN_TOOL_ASSISTANT_TURN_ID,
  },
];
