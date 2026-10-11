/**
 * Meridian's `RUN_STARTED.rawEvent`: the write mode a reply froze at start and
 * the user turns it was reserved to answer. Clients bind a reply to their send
 * by the admitted `userTurnId` (a writer's user turn id is its inbox message id),
 * never by stream order: a replayed start can belong to an unrelated reply.
 */
import { z } from "zod";
import { type AiWriteMode, aiWriteModeSchema } from "../works/ai-write-mode.js";

export type RunStartedMeta = {
  writeMode: AiWriteMode | null;
  /** Outstanding message ids (= user turn ids) this reply answers; empty for a Retry. */
  answersUserTurnIds: string[];
};

const runStartedMetaSchema = z.object({
  writeMode: aiWriteModeSchema.nullable().optional(),
  answersUserTurnIds: z.array(z.string()).optional(),
});

/** Reads a `RUN_STARTED.rawEvent`; missing or malformed fields read as unknown/empty. */
export function readRunStartedMeta(rawEvent: unknown): {
  writeMode: AiWriteMode | null | undefined;
  answersUserTurnIds: readonly string[];
} {
  const parsed = runStartedMetaSchema.safeParse(rawEvent);
  if (!parsed.success) return { writeMode: undefined, answersUserTurnIds: [] };
  return {
    writeMode: parsed.data.writeMode,
    answersUserTurnIds: parsed.data.answersUserTurnIds ?? [],
  };
}
