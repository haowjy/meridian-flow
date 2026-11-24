import type { DraftAnswers } from "@meridian/contracts/threads";

const PRESENCE_INTERVAL_MS = 30_000;
const ANSWERS_INTERVAL_MS = 5_000;

export type PresenceDraft = { askId: string; answers?: DraftAnswers };

export type PresenceReporter = {
  report(): void;
  flush(): void;
  stop(): void;
};

export function createPresenceReporter(
  send: (askId: string, answers?: DraftAnswers) => boolean,
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
