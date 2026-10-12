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

export type RunStartedMeta = {
  writeMode: AiWriteMode | null;
  /** The execution that reserved this reply; null on replies reserved before run identity. */
  executionId: string | null;
  /** Message ids (= user turn ids) the reply was reserved for; a Retry carries its failed reply's. */
  reservedForUserTurnIds: string[];
};

/** `meridian.messages.delivered`: the acknowledging turn and the messages it delivered. */
export type MessagesDeliveredValue = {
  /** Null when no turn was reserved (a child run aborted before its reservation). */
  byTurnId: string | null;
  executionId: string | null;
  userTurnIds: string[];
};

/** `meridian.execution.ended`: the execution will do no further work and its turns are terminal. */
export type ExecutionEndedValue = { executionId: string };

const runStartedMetaSchema = z.object({
  writeMode: aiWriteModeSchema.nullable().optional(),
  executionId: z.string().nullable().optional(),
  reservedForUserTurnIds: z.array(z.string()).optional(),
});

const messagesDeliveredSchema = z.object({
  byTurnId: z.string().nullable(),
  executionId: z.string().nullable(),
  userTurnIds: z.array(z.string()),
});

const executionEndedSchema = z.object({ executionId: z.string().min(1) });

/** Reads a `RUN_STARTED.rawEvent`; missing or malformed fields read as unknown/empty. */
export function readRunStartedMeta(rawEvent: unknown): {
  writeMode: AiWriteMode | null | undefined;
  executionId: string | null;
  reservedForUserTurnIds: readonly string[];
} {
  const parsed = runStartedMetaSchema.safeParse(rawEvent);
  if (!parsed.success)
    return { writeMode: undefined, executionId: null, reservedForUserTurnIds: [] };
  return {
    writeMode: parsed.data.writeMode,
    executionId: parsed.data.executionId ?? null,
    reservedForUserTurnIds: parsed.data.reservedForUserTurnIds ?? [],
  };
}

/** Reads a `meridian.messages.delivered` CUSTOM value; null when malformed. */
export function readMessagesDelivered(value: unknown): MessagesDeliveredValue | null {
  const parsed = messagesDeliveredSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Reads a `meridian.execution.ended` CUSTOM value; null when malformed. */
export function readExecutionEnded(value: unknown): ExecutionEndedValue | null {
  const parsed = executionEndedSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
