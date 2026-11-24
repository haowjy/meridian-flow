import type { OrchestratorEvent } from "../orchestrator-events.js";
import type { RunState } from "../run-state.js";
import { GOLDEN_EXECUTION_ID, goldenAssistantTurn } from "./turn-fixture.js";

export const GOLDEN_THREAD_ID = "thread_golden_text";
export const GOLDEN_ASSISTANT_TURN_ID = "turn_golden_asst_text";
export const GOLDEN_USER_TURN_ID = "turn_golden_user";

const assistantTurn = goldenAssistantTurn(GOLDEN_ASSISTANT_TURN_ID, GOLDEN_THREAD_ID, "streaming", [
  GOLDEN_USER_TURN_ID,
]);

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
