/**
 * Purpose: Defines the orchestrator event fixture for a simple assistant text turn.
 * Why independent: The fixture captures a shared contract sequence used to compare server projection behavior with AG-UI output.
 */
import type { OrchestratorEvent } from "../orchestrator-events.js";
import type { RunState } from "../run-state.js";
import { GOLDEN_EXECUTION_ID, goldenAssistantTurn } from "./turn-fixture.js";

export const GOLDEN_THREAD_ID = "thread_golden_text";
export const GOLDEN_ASSISTANT_TURN_ID = "turn_golden_asst_text";
/** The writer message the golden replies answer. */
export const GOLDEN_USER_TURN_ID = "turn_golden_user";

const assistantTurn = goldenAssistantTurn(GOLDEN_ASSISTANT_TURN_ID, GOLDEN_THREAD_ID, "streaming", [
  GOLDEN_USER_TURN_ID,
]);

/** The record while the reply runs, and after its execution ends (the writer message answered). */
export const GOLDEN_RECORD_RUNNING: Omit<RunState, "version"> = {
  items: [],
  sentThrough: 1,
  execution: { executionId: GOLDEN_EXECUTION_ID, currentTurnId: GOLDEN_ASSISTANT_TURN_ID },
  mode: "direct",
  blocked: null,
};
export const GOLDEN_RECORD_IDLE: Omit<RunState, "version"> = {
  ...GOLDEN_RECORD_RUNNING,
  execution: null,
};

/**
 * Assistant text stream: RUN_STARTED → two text deltas → the ack's record → RUN_FINISHED
 * → the record after the execution ends. The response's ack answers the message before the close.
 */
export const SIMPLE_TEXT_TURN_ORCHESTRATOR: OrchestratorEvent[] = [
  { type: "turn.created", turn: assistantTurn },
  { type: "stream.delta", kind: "text", text: "Hello" },
  { type: "stream.delta", kind: "text", text: " world" },
  { type: "run_state.changed", threadId: GOLDEN_THREAD_ID, runState: GOLDEN_RECORD_RUNNING },
  {
    type: "turn.completed",
    turn: goldenAssistantTurn(GOLDEN_ASSISTANT_TURN_ID, GOLDEN_THREAD_ID, "complete", [
      GOLDEN_USER_TURN_ID,
    ]),
  },
  { type: "run_state.changed", threadId: GOLDEN_THREAD_ID, runState: GOLDEN_RECORD_IDLE },
];
