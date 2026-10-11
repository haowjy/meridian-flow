/**
 * Meridian's run-boundary `rawEvent`s: how a client tells which reply answers
 * its send, by identity and never by stream order (a replayed start can belong
 * to an unrelated reply, and another client's reply can start right after ours).
 *
 * - `RUN_STARTED` names the user turns the reply answers (a writer's user turn
 *   id is its inbox message id) and the reply it continues under the same lease.
 * - `RUN_FINISHED` says whether its lease reserved such a successor, so a client
 *   knows to wait for a start whose `continuesRunId` names the finished run.
 */
import { z } from "zod";
import { type AiWriteMode, aiWriteModeSchema } from "../works/ai-write-mode.js";

export type RunStartedMeta = {
  writeMode: AiWriteMode | null;
  /** Outstanding message ids (= user turn ids) this reply answers; a Retry names its failed reply's. */
  answersUserTurnIds: string[];
  /** The reply this one continues under the same lease (steer, notice or compaction split), else null. */
  continuesRunId: string | null;
};

export type RunFinishedMeta = {
  /** A same-lease successor is reserved; its start names this run in `continuesRunId`. */
  continued: boolean;
};

const runStartedMetaSchema = z.object({
  writeMode: aiWriteModeSchema.nullable().optional(),
  answersUserTurnIds: z.array(z.string()).optional(),
  continuesRunId: z.string().nullable().optional(),
});

const runFinishedMetaSchema = z.object({ continued: z.boolean().optional() });

/** Reads a `RUN_STARTED.rawEvent`; missing or malformed fields read as unknown/empty. */
export function readRunStartedMeta(rawEvent: unknown): {
  writeMode: AiWriteMode | null | undefined;
  answersUserTurnIds: readonly string[];
  continuesRunId: string | null;
} {
  const parsed = runStartedMetaSchema.safeParse(rawEvent);
  if (!parsed.success)
    return { writeMode: undefined, answersUserTurnIds: [], continuesRunId: null };
  return {
    writeMode: parsed.data.writeMode,
    answersUserTurnIds: parsed.data.answersUserTurnIds ?? [],
    continuesRunId: parsed.data.continuesRunId ?? null,
  };
}

/** Reads a `RUN_FINISHED.rawEvent`; anything else reads as a plain finish. */
export function readRunFinishedMeta(rawEvent: unknown): RunFinishedMeta {
  const parsed = runFinishedMetaSchema.safeParse(rawEvent);
  return { continued: parsed.success && parsed.data.continued === true };
}
