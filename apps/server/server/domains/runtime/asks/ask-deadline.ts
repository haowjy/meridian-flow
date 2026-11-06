/**
 * When a question ask times out. The server owns both clocks; the client only reports that
 * the writer is interacting (`ask.presence`).
 *
 * The idle clock restarts on every report of activity on the page; the hard limit runs from the
 * moment the ask opened and never moves. Both clocks end a buffer before a default cache lifetime
 * so the next model call can still reuse the cache; a chat whose model caches for less can miss
 * it during the wait.
 */

import {
  DEFAULT_PRIMARY_PROMPT_CACHE_TTL,
  DEFAULT_SUBAGENT_PROMPT_CACHE_TTL,
} from "../gateway/index.js";

const ASK_IDLE_CACHE_BUFFER_MINUTES = 1;
const ASK_HARD_LIMIT_CACHE_BUFFER_MINUTES = 5;

export const ASK_IDLE_MS =
  (DEFAULT_SUBAGENT_PROMPT_CACHE_TTL - ASK_IDLE_CACHE_BUFFER_MINUTES) * 60_000;
export const ASK_HARD_LIMIT_MS =
  (DEFAULT_PRIMARY_PROMPT_CACHE_TTL - ASK_HARD_LIMIT_CACHE_BUFFER_MINUTES) * 60_000;

/**
 * The deadline an idle clock started at `now` gives an ask that opened at `openedAt`, in whole
 * seconds so a client's presence message a moment later doesn't count as a different deadline.
 */
export function askDeadline(now: Date, openedAt: Date): Date {
  const deadline = Math.min(now.getTime() + ASK_IDLE_MS, openedAt.getTime() + ASK_HARD_LIMIT_MS);
  return new Date(Math.floor(deadline / 1000) * 1000);
}
