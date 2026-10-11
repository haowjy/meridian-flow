/**
 * The one runtime-control vocabulary: the `ControlBody` type and the wire
 * schemas every reader (HTTP admission, socket frames, CLI) builds on.
 */
import { z } from "zod";
import { aiWriteModeSchema } from "../works/ai-write-mode.js";

export const compactControlBodySchema = z.object({
  kind: z.literal("compact"),
  instructions: z.string().optional(),
});

export const writeModeControlBodySchema = z.object({
  kind: z.literal("write_mode"),
  mode: aiWriteModeSchema,
});

export const controlBodySchema = z.discriminatedUnion("kind", [
  compactControlBodySchema,
  writeModeControlBodySchema,
]);

/**
 * Runtime commands take their transcript position at execution, not enqueue.
 * `write_mode` switches one chat's AI write mode once no reply holds the chat.
 */
export type ControlBody = z.infer<typeof controlBodySchema>;
