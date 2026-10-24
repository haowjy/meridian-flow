/**
 * Purpose: Defines the expected AG-UI event stream for the simple text golden turn.
 * Why independent: The fixture is a shared protocol contract example consumed by projectors and client tests, not runtime orchestration code.
 */
import { type AGUIEvent, EventType, RUN_STATE_EVENT } from "../../protocol/index.js";

import {
  GOLDEN_ASSISTANT_TURN_ID,
  GOLDEN_RECORD_IDLE,
  GOLDEN_RECORD_RUNNING,
  GOLDEN_THREAD_ID,
} from "./simple-text-turn.js";

/** Golden AG-UI stream for {@link SIMPLE_TEXT_TURN_ORCHESTRATOR} (server projector output). */
export const SIMPLE_TEXT_TURN_AGUI: AGUIEvent[] = [
  {
    type: EventType.RUN_STARTED,
    threadId: GOLDEN_THREAD_ID,
    runId: GOLDEN_ASSISTANT_TURN_ID,
    rawEvent: { writeMode: null },
  },
  {
    type: EventType.TEXT_MESSAGE_START,
    messageId: `${GOLDEN_ASSISTANT_TURN_ID}::0`,
    role: "assistant",
  },
  {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: `${GOLDEN_ASSISTANT_TURN_ID}::0`,
    delta: "Hello",
  },
  {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: `${GOLDEN_ASSISTANT_TURN_ID}::0`,
    delta: " world",
  },
  { type: EventType.CUSTOM, name: RUN_STATE_EVENT, value: GOLDEN_RECORD_RUNNING },
  {
    type: EventType.TEXT_MESSAGE_END,
    messageId: `${GOLDEN_ASSISTANT_TURN_ID}::0`,
  },
  {
    type: EventType.RUN_FINISHED,
    threadId: GOLDEN_THREAD_ID,
    runId: GOLDEN_ASSISTANT_TURN_ID,
  },
  { type: EventType.CUSTOM, name: RUN_STATE_EVENT, value: GOLDEN_RECORD_IDLE },
];
