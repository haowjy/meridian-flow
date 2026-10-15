/**
 * Meridian's run-boundary frames on the AG-UI stream: the run-state record, a write-mode switch
 * that applied, and waiting messages that left the chat. Whether a chat works, which execution is
 * open and which messages are owed is the record's (`meridian.run_state`, one `RunState` per
 * version); nothing is inferred from stream order or transcript ancestry.
 *
 * - An **execution** is one hold of the run lease. Every turn it reserves carries
 *   its id (`Turn.executionId`), and `Turn.position` is the thread's write-once insertion
 *   order. They live on the snapshot's turns, not on `RUN_STARTED`: a client that needs a
 *   reply's identity reads a snapshot (`messageFate`).
 * - `reservedForUserTurnIds` names the messages a reply was reserved to handle.
 *   It is a hint, never proof that they were answered.
 */
import { z } from "zod";
import { type AiWriteMode, aiWriteModeSchema } from "../works/ai-write-mode.js";

/** `meridian.messages.handed_back`: waiting writer messages that left the chat. */
export const MESSAGES_HANDED_BACK_EVENT = "meridian.messages.handed_back" as const;
export const WRITE_MODE_SWITCHED_EVENT = "meridian.write_mode.switched" as const;
/** `meridian.run_state`: the chat's whole `RunState`, stamped with its stream version. */
export const RUN_STATE_EVENT = "meridian.run_state" as const;

export type RunStartedMeta = {
  writeMode: AiWriteMode | null;
};

/**
 * `meridian.write_mode.switched`: a queued or idle switch applied. Its journal seq answers the
 * switch intent for its control; the record of the same commit follows and carries the mode.
 * The frame names where the switch turn sits, so a follower places it by the turn it follows
 * and never by where its own transcript happens to end.
 */
export type WriteModeSwitchedValue = {
  threadId: string;
  mode: AiWriteMode;
  /** The control message that asked for the switch. */
  controlId: string;
  /** The complete `system` switch turn. */
  turnId: string;
  /** Where the switch turn sits: the turn it follows (null at the head of the chat) and its position. */
  prevTurnId: string | null;
  position: number;
};

const writeModeSwitchedSchema = z.object({
  mode: aiWriteModeSchema,
  controlId: z.string(),
  turnId: z.string(),
  prevTurnId: z.string().nullable(),
  position: z.number().int(),
});

/** Reads a `meridian.write_mode.switched` CUSTOM value; null when malformed. */
export function readWriteModeSwitched(
  value: unknown,
): Pick<
  WriteModeSwitchedValue,
  "mode" | "controlId" | "turnId" | "prevTurnId" | "position"
> | null {
  const parsed = writeModeSwitchedSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const runStartedMetaSchema = z.object({
  writeMode: aiWriteModeSchema.nullable().optional(),
});

const messagesHandedBackSchema = z.object({ userTurnIds: z.array(z.string()) });

/** Reads a `RUN_STARTED.rawEvent`; missing or malformed fields read as unknown/empty. */
export function readRunStartedMeta(rawEvent: unknown): {
  writeMode: AiWriteMode | null | undefined;
} {
  const parsed = runStartedMetaSchema.safeParse(rawEvent);
  return { writeMode: parsed.success ? parsed.data.writeMode : undefined };
}

/** `meridian.messages.handed_back`: the user turns that left the conversation. */
export type MessagesHandedBackValue = { userTurnIds: string[] };

/** Reads a `meridian.messages.handed_back` CUSTOM value; null when malformed. */
export function readMessagesHandedBack(value: unknown): MessagesHandedBackValue | null {
  const parsed = messagesHandedBackSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
