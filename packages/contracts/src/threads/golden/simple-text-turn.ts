/**
 * Purpose: Defines the orchestrator event fixture for a simple assistant text turn.
 * Why independent: The fixture captures a shared contract sequence used to compare server projection behavior with AG-UI output.
 */
import type { OrchestratorEvent } from "../orchestrator-events.js";
import { goldenAssistantTurn } from "./turn-fixture.js";

export const GOLDEN_THREAD_ID = "thread_golden_text";
export const GOLDEN_ASSISTANT_TURN_ID = "turn_golden_asst_text";

const assistantTurn = goldenAssistantTurn(GOLDEN_ASSISTANT_TURN_ID, GOLDEN_THREAD_ID);

/** Assistant text stream: RUN_STARTED → two text deltas → RUN_FINISHED. */
export const SIMPLE_TEXT_TURN_ORCHESTRATOR: OrchestratorEvent[] = [
  { type: "turn.created", turn: assistantTurn },
  { type: "stream.delta", kind: "text", text: "Hello" },
  { type: "stream.delta", kind: "text", text: " world" },
  {
    type: "turn.completed",
    turn: goldenAssistantTurn(GOLDEN_ASSISTANT_TURN_ID, GOLDEN_THREAD_ID, "complete"),
  },
];
