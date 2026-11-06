/**
 * Reports the writer's presence to the server as `ask.presence`, at most once per
 * `PRESENCE_INTERVAL_MS`, so the idle deadline stays off while they are on the page. A report
 * carries the draft answers only when they changed since the last one that left: plain activity
 * moves the clock and leaves the draft the server holds (another tab or device may have newer
 * answers) alone. A report waiting on that interval is sent by `flush` (the writer leaves, or
 * the page hides), and one the socket couldn't carry is sent when it connects again, with its
 * draft. Plain state, no React.
 */
import type { DraftAnswers } from "@meridian/contracts/threads";

/** The server's idle clock is minutes long; this keeps it moving without a frame per keystroke. */
const PRESENCE_INTERVAL_MS = 30_000;

export type PresenceReporter = {
  /** Report now, or once the interval since the last report has passed. `answers` is a draft change. */
  report(answers?: DraftAnswers): void;
  /** Send what is owed (a report waiting on the interval, or one the socket dropped). */
  flush(): void;
  /** Drop what is owed and restart the interval: the ask ended or the answer carries the draft. */
  stop(): void;
};

export function createPresenceReporter(
  send: (askId: string, answers?: DraftAnswers) => boolean,
  /** The id of the question ask open now; null when none. */
  readAskId: () => string | null,
): PresenceReporter {
  let sentAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The draft changed and no send has carried it yet; cleared only by a send that left.
  let dirty: DraftAnswers | null = null;
  // The last report couldn't leave (socket down), so it is owed on reconnect.
  let unsent = false;

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  function sendNow() {
    clearTimer();
    const askId = readAskId();
    if (!askId) return;
    const sent = send(askId, dirty ?? undefined);
    if (sent) {
      sentAt = Date.now();
      dirty = null;
    }
    unsent = !sent;
  }
  return {
    report(answers) {
      if (answers) dirty = answers;
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
      dirty = null;
      unsent = false;
    },
  };
}
