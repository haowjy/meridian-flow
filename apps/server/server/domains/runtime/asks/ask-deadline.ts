/**
 * When a question ask times out. The server owns both clocks; the client only reports that
 * the writer is interacting (`ask.presence`).
 *
 * The idle clock restarts on every report of activity on the page; the hard limit runs from the
 * moment the ask opened and never moves. Only primary chats ask, so the hard limit is the clock
 * that protects the cache: it ends a buffer before the asking model's long lifetime, fixed on
 * the ask when it is requested (`askHardLimitSeconds`) so a later change of the chat's model
 * leaves an open ask alone. The idle clock protects no cache: it is a fixed policy for how long
 * a question waits on a writer who has gone quiet.
 */

import type { PromptCacheDescriptor } from "@meridian-flow/runtime/gateway";

const ASK_IDLE_SECONDS = 4 * 60;
const ASK_HARD_LIMIT_CACHE_BUFFER_SECONDS = 5 * 60;
/** The hard limit of a model with no documented cache lifetime (Gemini's implicit cache): a policy, not a cache fact. */
const NO_LIFETIME_HARD_LIMIT_SECONDS = 55 * 60;

/** The hard limit an ask gets from the model that asks it; `null` when the model is not known. */
export function askHardLimitSeconds(
  promptCache: Pick<PromptCacheDescriptor, "longTtlSeconds"> | null,
): number {
  const lifetime = promptCache?.longTtlSeconds ?? null;
  return lifetime === null
    ? NO_LIFETIME_HARD_LIMIT_SECONDS
    : lifetime - ASK_HARD_LIMIT_CACHE_BUFFER_SECONDS;
}

/**
 * The deadline an idle clock started at `now` gives an ask that opened at `openedAt`, in whole
 * seconds so a client's presence message a moment later doesn't count as a different deadline.
 */
export function askDeadline(now: Date, openedAt: Date, hardLimitSeconds: number): Date {
  const deadline = Math.min(
    now.getTime() + ASK_IDLE_SECONDS * 1_000,
    openedAt.getTime() + hardLimitSeconds * 1_000,
  );
  return new Date(Math.floor(deadline / 1000) * 1000);
}
