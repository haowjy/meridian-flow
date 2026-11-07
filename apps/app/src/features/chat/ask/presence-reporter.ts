/**
 * Reports the writer's presence to the server as `ask.presence`, so the idle deadline stays off
 * while they are on the page. The reporter holds no state about the draft: `readDraft` says what
 * a report carries. A clock-only report goes at most once per `PRESENCE_INTERVAL_MS`; one
 * carrying answers (the draft has changes the server hasn't echoed) goes at most once per
 * `ANSWERS_INTERVAL_MS`, and a clock-only send never uses that interval up, so a click right
 * after a pointer move still reaches the server within seconds. A report waiting on its interval
 * is sent by `flush` (the writer leaves, the page hides, or the socket connects), which also
 * sends owed answers at once. Plain state, no React.
 */
import type { DraftAnswers } from "@meridian/contracts/threads";

/** The server's idle clock is minutes long; this keeps it moving without a frame per keystroke. */
const PRESENCE_INTERVAL_MS = 30_000;
/** Each changed draft writes a journal row, so typing can't send on every keystroke. */
const ANSWERS_INTERVAL_MS = 5_000;

/** What a report carries: the open ask, and the answers the server hasn't echoed yet, if any. */
export type PresenceDraft = { askId: string; answers?: DraftAnswers };

export type PresenceReporter = {
  /** Report now, or once the interval for what it carries has passed. */
  report(): void;
  /** Send what is waiting on an interval, and any answers still owed. */
  flush(): void;
  /** Restart the intervals: the ask ended or its answer is on the way. What the draft still owes is not forgotten. */
  stop(): void;
};

export function createPresenceReporter(
  send: (askId: string, answers?: DraftAnswers) => boolean,
  /** The report to send now; null when no question ask is open here. */
  readDraft: () => PresenceDraft | null,
): PresenceReporter {
  let sentAt = Number.NEGATIVE_INFINITY;
  let answersSentAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerDue = Number.POSITIVE_INFINITY;

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  function sendNow() {
    clearTimer();
    const draft = readDraft();
    if (!draft) return;
    if (!send(draft.askId, draft.answers)) return;
    sentAt = Date.now();
    if (draft.answers) answersSentAt = sentAt;
  }
  return {
    report() {
      const draft = readDraft();
      if (!draft) return;
      const now = Date.now();
      const due = draft.answers
        ? answersSentAt + ANSWERS_INTERVAL_MS
        : sentAt + PRESENCE_INTERVAL_MS;
      if (due <= now) sendNow();
      else if (!timer || due < timerDue) {
        clearTimer();
        timerDue = due;
        timer = setTimeout(sendNow, due - now);
      }
    },
    flush() {
      if (timer || readDraft()?.answers) sendNow();
    },
    stop() {
      clearTimer();
      sentAt = Number.NEGATIVE_INFINITY;
      answersSentAt = Number.NEGATIVE_INFINITY;
    },
  };
}
