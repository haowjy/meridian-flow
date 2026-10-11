/** Where AI writes land for a chat: straight into live documents, or into review drafts. */
import { z } from "zod";

export const aiWriteModeSchema = z.enum(["direct", "draft"]);

export type AiWriteMode = z.infer<typeof aiWriteModeSchema>;
