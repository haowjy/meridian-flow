/**
 * Reports the writer's held draft to the server as `ask.presence`, at most once per
 * `PRESENCE_INTERVAL_MS`, so the idle deadline stays off and a walk-away keeps what they chose.
 * A report waiting on that interval is sent by `flush` (the writer leaves, or the page hides), and
 * one the socket couldn't carry is sent when it connects again. Plain state, no React.
 */
import type { DraftAnswers } from "@meridian/contracts/threads";

/** The server's idle clock is minutes long; this keeps it moving without a frame per keystroke. */
const PRESENCE_INTERVAL_MS = 30_000;

export type PresenceReporter = {
  /** Report the held draft now, or once the interval since the last report has passed. */
  report(): void;
  /** Send what is owed (a report waiting on the interval, or one the socket dropped). */
  flush(): void;
  /** Drop what is owed and restart the interval: the ask ended or the answer carries the draft. */
  stop(): void;
};

export function createPresenceReporter(
  send: (askId: string, answers: DraftAnswers) => boolean,
  /** The ask and answers the writer holds now; null when none. */
  readDraft: () => { askId: string; answers: DraftAnswers } | null,
): PresenceReporter {
  let sentAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The last report couldn't leave (socket down), so it is owed on reconnect.
  let unsent = false;

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  function sendNow() {
    clearTimer();
    const draft = readDraft();
    if (!draft) return;
    const sent = send(draft.askId, draft.answers);
    if (sent) sentAt = Date.now();
    unsent = !sent;
  }
  return {
    report() {
      const wait = sentAt + PRESENCE_INTERVAL_MS - Date.now();
      if (wait <= 0) sendNow();
      else timer ??= setTimeout(sendNow, wait);
    },
    flush() {
      if (timer || unsent) sendNow();
    },
    stop() {
      clearTimer();
      sentAt = Number.NEGATIVE_INFINITY;
      unsent = false;
    },
  };
}
