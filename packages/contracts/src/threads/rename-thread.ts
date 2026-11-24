import { z } from "zod";

export const THREAD_TITLE_MAX_LENGTH = 200;

export const renameThreadRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(THREAD_TITLE_MAX_LENGTH),
  })
  .strict();

export type RenameThreadRequest = z.infer<typeof renameThreadRequestSchema>;

export interface RenameThreadResponse {
  threadId: string;
  title: string;
  updatedAt: string;
}
