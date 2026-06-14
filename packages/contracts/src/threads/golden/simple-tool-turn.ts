/**
 * Purpose: Defines the orchestrator event fixture for an assistant tool-call turn.
 * Why independent: The fixture captures the shared thread/protocol contract sequence while actual tool execution stays in runtime domains.
 */
import type { OrchestratorEvent } from "../orchestrator-events.js";
import { GOLDEN_THREAD_ID } from "./simple-text-turn.js";
import { goldenAssistantTurn } from "./turn-fixture.js";

export const GOLDEN_TOOL_CALL_ID = "call_golden_tool_1";
export const GOLDEN_TOOL_ASSISTANT_TURN_ID = "turn_golden_asst_tool";

const assistantTurn = goldenAssistantTurn(GOLDEN_TOOL_ASSISTANT_TURN_ID, GOLDEN_THREAD_ID);

/** Tool call start/args → executing activity → result → complete. */
export const SIMPLE_TOOL_TURN_ORCHESTRATOR: OrchestratorEvent[] = [
  { type: "turn.created", turn: assistantTurn },
  {
    type: "stream.delta",
    kind: "tool_call",
    toolCallId: GOLDEN_TOOL_CALL_ID,
    toolName: "read_file",
    argumentsDelta: '{"path":',
  },
  {
    type: "stream.delta",
    kind: "tool_call",
    toolCallId: GOLDEN_TOOL_CALL_ID,
    toolName: "read_file",
    argumentsDelta: '"/tmp/x"}',
  },
  { type: "tool.executing", toolCallId: GOLDEN_TOOL_CALL_ID, name: "read_file" },
  {
    type: "tool.result",
    toolCallId: GOLDEN_TOOL_CALL_ID,
    output: "file contents",
  },
  {
    type: "turn.completed",
    turn: goldenAssistantTurn(GOLDEN_TOOL_ASSISTANT_TURN_ID, GOLDEN_THREAD_ID, "complete"),
  },
];
