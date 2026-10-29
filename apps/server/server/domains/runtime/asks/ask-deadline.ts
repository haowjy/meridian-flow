/**
 * When a question ask times out. The server owns both clocks; the client only reports that
 * the writer is interacting (`ask.presence`).
 *
 * The idle clock restarts on every interaction; the hard limit runs from the moment the ask
 * opened and never moves. The limit stays under the main chat's 1-hour prompt cache.
 */

export const ASK_IDLE_MS = 4 * 60_000;
export const ASK_HARD_LIMIT_MS = 55 * 60_000;

/** The deadline an idle clock started at `now` gives an ask that opened at `openedAt`. */
export function askDeadline(now: Date, openedAt: Date): Date {
  return new Date(Math.min(now.getTime() + ASK_IDLE_MS, openedAt.getTime() + ASK_HARD_LIMIT_MS));
}
