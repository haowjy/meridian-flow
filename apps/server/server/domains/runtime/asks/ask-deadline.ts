/**
 * When a question ask times out. The server owns both clocks; the client only reports that
 * the writer is interacting (`ask.presence`).
 *
 * The idle clock restarts on every report of activity on the page; the hard limit runs from the
 * moment the ask opened and never moves. Only primary chats ask, so the hard limit is the clock
 * that protects the cache: it ends a buffer before the primary default lifetime, and a chat whose
 * model caches for less can miss its cache during the wait. The idle clock protects no cache. It
 * sets how long a question waits on a writer who has gone quiet, and takes its length from the
 * subagent default.
 */

import {
  DEFAULT_PRIMARY_PROMPT_CACHE_TTL,
  DEFAULT_SUBAGENT_PROMPT_CACHE_TTL,
} from "@meridian-flow/gateway";

const ASK_IDLE_CACHE_BUFFER_SECONDS = 60;
const ASK_HARD_LIMIT_CACHE_BUFFER_SECONDS = 5 * 60;

export const ASK_IDLE_MS =
  (DEFAULT_SUBAGENT_PROMPT_CACHE_TTL - ASK_IDLE_CACHE_BUFFER_SECONDS) * 1_000;
export const ASK_HARD_LIMIT_MS =
  (DEFAULT_PRIMARY_PROMPT_CACHE_TTL - ASK_HARD_LIMIT_CACHE_BUFFER_SECONDS) * 1_000;

/**
 * The deadline an idle clock started at `now` gives an ask that opened at `openedAt`, in whole
 * seconds so a client's presence message a moment later doesn't count as a different deadline.
 */
export function askDeadline(now: Date, openedAt: Date): Date {
  const deadline = Math.min(now.getTime() + ASK_IDLE_MS, openedAt.getTime() + ASK_HARD_LIMIT_MS);
  return new Date(Math.floor(deadline / 1000) * 1000);
}
