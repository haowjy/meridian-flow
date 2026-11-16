/**
 * When a question ask times out. The server owns both clocks; the client only reports that
 * the writer is interacting (`ask.presence`).
 *
 * The idle clock restarts on every report of activity on the page; the hard limit runs from the
 * moment the ask opened and never moves. Only primary chats ask, so the hard limit is the clock
 * that protects the cache: it ends a buffer before the asking model's long lifetime. The idle
 * clock sets how long a question waits on a writer who has gone quiet, and ends a buffer before
 * the short lifetime. Both lengths are fixed on the ask when it is requested (`askClock`), so a
 * later change of the chat's model leaves an open ask alone.
 */

import type { PromptCacheDescriptor } from "@meridian-flow/runtime/gateway";

const ASK_IDLE_CACHE_BUFFER_SECONDS = 60;
const ASK_HARD_LIMIT_CACHE_BUFFER_SECONDS = 5 * 60;

/**
 * What a model with no documented cache lifetime gets (Gemini's implicit cache): there is no
 * lifetime to stay inside, so these are the clocks a question gets by policy, not a cache fact.
 */
const NO_LIFETIME_CLOCK = { idleSeconds: 4 * 60, hardLimitSeconds: 55 * 60 };

export interface AskClock {
  idleSeconds: number;
  hardLimitSeconds: number;
}

/** The clocks an ask gets from the model that asks it; `null` when the model is not known. */
export function askClock(
  promptCache: Pick<PromptCacheDescriptor, "shortTtlSeconds" | "longTtlSeconds"> | null,
): AskClock {
  const { shortTtlSeconds, longTtlSeconds } = promptCache ?? {
    shortTtlSeconds: null,
    longTtlSeconds: null,
  };
  return {
    idleSeconds:
      shortTtlSeconds === null
        ? NO_LIFETIME_CLOCK.idleSeconds
        : shortTtlSeconds - ASK_IDLE_CACHE_BUFFER_SECONDS,
    hardLimitSeconds:
      longTtlSeconds === null
        ? NO_LIFETIME_CLOCK.hardLimitSeconds
        : longTtlSeconds - ASK_HARD_LIMIT_CACHE_BUFFER_SECONDS,
  };
}

/**
 * The deadline an idle clock started at `now` gives an ask that opened at `openedAt`, in whole
 * seconds so a client's presence message a moment later doesn't count as a different deadline.
 */
export function askDeadline(now: Date, openedAt: Date, clock: AskClock): Date {
  const deadline = Math.min(
    now.getTime() + clock.idleSeconds * 1_000,
    openedAt.getTime() + clock.hardLimitSeconds * 1_000,
  );
  return new Date(Math.floor(deadline / 1000) * 1000);
}
