import { z } from "zod";
import { type AiWriteMode, aiWriteModeSchema } from "../works/ai-write-mode.js";

export const MESSAGES_HANDED_BACK_EVENT = "meridian.messages.handed_back" as const;
export const TURNS_FORGOTTEN_EVENT = "meridian.turns.forgotten" as const;
export const WRITE_MODE_SWITCHED_EVENT = "meridian.write_mode.switched" as const;
export const RUN_STATE_EVENT = "meridian.run_state" as const;

export type RunStartedMeta = {
  writeMode: AiWriteMode | null;
};

export type WriteModeSwitchedValue = {
  threadId: string;
  mode: AiWriteMode;
  controlId: string;
  turnId: string;
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

const turnsForgottenSchema = z.object({
  turnIds: z.array(z.string()),
  byTurnId: z.string(),
  reason: z.enum(["retried", "forgotten"]),
});

const messagesHandedBackSchema = z.object({ userTurnIds: z.array(z.string()) });

export function readRunStartedMeta(rawEvent: unknown): {
  writeMode: AiWriteMode | null | undefined;
} {
  const parsed = runStartedMetaSchema.safeParse(rawEvent);
  return { writeMode: parsed.success ? parsed.data.writeMode : undefined };
}

export type MessagesHandedBackValue = { userTurnIds: string[] };

export function readMessagesHandedBack(value: unknown): MessagesHandedBackValue | null {
  const parsed = messagesHandedBackSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type TurnsForgottenValue = z.infer<typeof turnsForgottenSchema>;

export function readTurnsForgotten(value: unknown): TurnsForgottenValue | null {
  const parsed = turnsForgottenSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
