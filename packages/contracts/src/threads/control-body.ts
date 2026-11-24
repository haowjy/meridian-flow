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

export type ControlBody = z.infer<typeof controlBodySchema>;
