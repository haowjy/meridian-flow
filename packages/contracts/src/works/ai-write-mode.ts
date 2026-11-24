import { z } from "zod";

export const aiWriteModeSchema = z.enum(["direct", "draft"]);

export type AiWriteMode = z.infer<typeof aiWriteModeSchema>;

export function effectiveAiWriteMode(
  applied: AiWriteMode,
  queued: AiWriteMode | null,
): AiWriteMode {
  return queued ?? applied;
}
