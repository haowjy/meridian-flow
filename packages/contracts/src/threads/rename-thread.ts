import { z } from "zod";

export const THREAD_TITLE_MAX_LENGTH = 200;

export const renameThreadRequestSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .transform((title) => title.slice(0, THREAD_TITLE_MAX_LENGTH)),
  })
  .strict();
