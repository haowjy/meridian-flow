/**
 * Meridian's run-identity facts on the AG-UI stream: which execution reserved a
 * reply, which turn delivered a writer's message, and when an execution ended.
 * Each is server-decided and write-once, so a client merges stream and snapshot
 * facts by union and never infers them from stream order or transcript ancestry.
 *
 * - An **execution** is one hold of the run lease. Every turn it reserves carries
 *   its id (`Turn.executionId`); `RUN_STARTED.rawEvent.executionId` repeats it.
 * - `reservedForUserTurnIds` names the messages a reply was reserved to handle.
 *   It is a hint for binding and Stop, never proof that they were answered.
 * - `meridian.messages.delivered` is the only "my message is done" fact.
 * - `position` (`Turn.position`) is the thread's write-once insertion order. A
 *   client picks an execution's latest turn by it, never by arrival order.
 * - `meridian.execution.ended` is journaled once, after every turn the execution
 *   reserved is terminal. The snapshot's `liveState.openExecutionId` carries the
 *   same fact: a snapshot execution that is not open has ended.
 *
 * Old journal payloads lack these fields and read as unknown (null / empty).
 */
import { z } from "zod";
import { type AiWriteMode, aiWriteModeSchema } from "../works/ai-write-mode.js";

export const MESSAGES_DELIVERED_EVENT = "meridian.messages.delivered" as const;
export const EXECUTION_ENDED_EVENT = "meridian.execution.ended" as const;
/** `meridian.messages.handed_back`: waiting writer messages that left the chat. */
export const MESSAGES_HANDED_BACK_EVENT = "meridian.messages.handed_back" as const;
export const WRITE_MODE_SWITCHED_EVENT = "meridian.write_mode.switched" as const;
/** `meridian.run_state`: the chat's whole `RunState`, stamped with its stream version. */
export const RUN_STATE_EVENT = "meridian.run_state" as const;

export type RunStartedMeta = {
  writeMode: AiWriteMode | null;
  /** The execution that reserved this reply; null on replies reserved before run identity. */
  executionId: string | null;
  /** Message ids (= user turn ids) the reply was reserved for; a Retry carries its failed reply's. */
  reservedForUserTurnIds: string[];
  /** The reply's `Turn.position`; null on journal payloads written before it was recorded. */
  position: number | null;
};

/** `meridian.messages.delivered`: the acknowledging turn and the messages it delivered. */
export type MessagesDeliveredValue = {
  /** Null when no turn was reserved (a child run aborted before its reservation). */
  byTurnId: string | null;
  /** The deliverer's `Turn.position`; null when the deliverer is unknown. */
  byTurnPosition: number | null;
  executionId: string | null;
  userTurnIds: string[];
};

/** `meridian.execution.ended`: the execution will do no further work and its turns are terminal. */
export type ExecutionEndedValue = { executionId: string };

/**
 * `meridian.write_mode.switched`: a queued or idle switch applied. It carries
 * the journal seq of the transition itself, so a client orders the new mode
 * against every `meridian.inbox.changed` and answer `seq` on one clock.
 */
export type WriteModeSwitchedValue = {
  threadId: string;
  mode: AiWriteMode;
  /** The control message that asked for the switch. */
  controlId: string;
  /** The complete `system` switch turn. */
  turnId: string;
};

const runStartedMetaSchema = z.object({
  writeMode: aiWriteModeSchema.nullable().optional(),
  executionId: z.string().nullable().optional(),
  reservedForUserTurnIds: z.array(z.string()).optional(),
  position: z.number().int().nullable().optional(),
});

const messagesDeliveredSchema = z.object({
  byTurnId: z.string().nullable(),
  byTurnPosition: z.number().int().nullable().optional(),
  executionId: z.string().nullable(),
  userTurnIds: z.array(z.string()),
});

const messagesHandedBackSchema = z.object({ userTurnIds: z.array(z.string()) });

const executionEndedSchema = z.object({ executionId: z.string().min(1) });

/** Reads a `RUN_STARTED.rawEvent`; missing or malformed fields read as unknown/empty. */
export function readRunStartedMeta(rawEvent: unknown): {
  writeMode: AiWriteMode | null | undefined;
  executionId: string | null;
  reservedForUserTurnIds: readonly string[];
  position: number | null;
} {
  const parsed = runStartedMetaSchema.safeParse(rawEvent);
  if (!parsed.success)
    return { writeMode: undefined, executionId: null, reservedForUserTurnIds: [], position: null };
  return {
    writeMode: parsed.data.writeMode,
    executionId: parsed.data.executionId ?? null,
    reservedForUserTurnIds: parsed.data.reservedForUserTurnIds ?? [],
    position: parsed.data.position ?? null,
  };
}

/** Reads a `meridian.messages.delivered` CUSTOM value; null when malformed. */
export function readMessagesDelivered(value: unknown): MessagesDeliveredValue | null {
  const parsed = messagesDeliveredSchema.safeParse(value);
  return parsed.success
    ? { ...parsed.data, byTurnPosition: parsed.data.byTurnPosition ?? null }
    : null;
}

/** Reads a `meridian.execution.ended` CUSTOM value; null when malformed. */
export function readExecutionEnded(value: unknown): ExecutionEndedValue | null {
  const parsed = executionEndedSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** `meridian.messages.handed_back`: the user turns that left the conversation. */
export type MessagesHandedBackValue = { userTurnIds: string[] };

/** Reads a `meridian.messages.handed_back` CUSTOM value; null when malformed. */
export function readMessagesHandedBack(value: unknown): MessagesHandedBackValue | null {
  const parsed = messagesHandedBackSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
