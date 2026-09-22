/**
 * Explicit thread-rename command boundary: the writer sets a thread title and
 * the server persists it. Rename is thread state, not per-user state, so it has
 * its own request/response contract instead of riding `user-state`.
 */
import { z } from "zod";

export const THREAD_TITLE_MAX_LENGTH = 200;

export const renameThreadRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(THREAD_TITLE_MAX_LENGTH),
  })
  .strict();

export type RenameThreadRequest = z.infer<typeof renameThreadRequestSchema>;

/** Minimal confirmation of the persisted title (mirrors the favorite response shape). */
export interface RenameThreadResponse {
  threadId: string;
  title: string;
  updatedAt: string;
}
