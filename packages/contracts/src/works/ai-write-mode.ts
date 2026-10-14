/** Where AI writes land for a chat: straight into live documents, or into review drafts. */
import { z } from "zod";

export const aiWriteModeSchema = z.enum(["direct", "draft"]);

export type AiWriteMode = z.infer<typeof aiWriteModeSchema>;

/** The mode the chat will write in: a queued switch wins over the applied mode. The one rule. */
export function effectiveAiWriteMode(
  applied: AiWriteMode,
  queued: AiWriteMode | null,
): AiWriteMode {
  return queued ?? applied;
}
