/**
 * The chat composer's open-ask mode: the takeover to draw in the box's place, and the writer's
 * draft of the answers (which question they're on, each one's choice and typed words). The draft
 * outlives the takeover, which also hides while this device's answer sends or settles, so a failed
 * send reopens with every answer in place. A refused answer isn't a failed send: it shows a
 * message with no Retry until the writer changes something.
 *
 * Nothing typed is lost: when the ask ends, words that aren't in how it ended (left in a field
 * beside a picked option, or sent but beaten by another resolution) are added to the composer
 * draft once. Closure follows the ask's lifecycle, not the takeover.
 *
 * A takeover that opens with no local draft (a reload, another device) starts from the answers
 * the server holds for the ask (`draftAnswers`), the ones a timeout would use. With two tabs open
 * the last one to report wins. A send the server refuses as `invalid_answer` moves the draft to
 * the question it names.
 *
 * While the writer works on a question, the draft goes to the server as `ask.presence`, at most
 * once per `PRESENCE_INTERVAL_MS`, so the idle deadline stays off and a walk-away keeps what
 * they chose. A report waiting on that interval is sent when the writer leaves or the page hides,
 * and one the socket couldn't carry is sent when it connects again.
 */
import type { ThreadAsk } from "@meridian/contracts/threads";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useOpenAsk, useThreadStore } from "@/client/stores";
import type { ComposerHandle } from "@/components/app/composer";
import { AskTakeover, type QuestionDraft } from "./AskTakeover";
import { useAnswerAsk } from "./useAnswerAsk";

type HeldDraft = QuestionDraft & { askId: string | null };

const NONE: HeldDraft = { askId: null, step: 0, entries: [] };

/** The server's idle clock is minutes long; this keeps it moving without a frame per keystroke. */
const PRESENCE_INTERVAL_MS = 30_000;

export function useAskTakeover(threadId: string, composer: RefObject<ComposerHandle | null>) {
  const open = useOpenAsk(threadId);
  const commands = useAnswerAsk(threadId);
  const openId = open?.ask.id ?? null;
  const [held, setHeld] = useState<HeldDraft>(NONE);
  // The ref is the truth for the effect and the presence timer: it changes with each write,
  // before any render the answer's store update causes.
  const heldRef = useRef(held);
  const write = useCallback((next: HeldDraft) => {
    heldRef.current = next;
    setHeld(next);
  }, []);
  // The ask whose last answer the server refused; any change to its draft clears it.
  const [refusedAsk, setRefusedAsk] = useState<string | null>(null);
  const tracked = useThreadStore((state) =>
    held.askId === null ? undefined : state.syncedByThread[threadId]?.asks.byId.get(held.askId),
  );
  // `unsent`: the last report couldn't leave (socket down), so it is owed on reconnect.
  const presence = useRef<{
    sentAt: number;
    timer: ReturnType<typeof setTimeout> | null;
    unsent: boolean;
  }>({ sentAt: Number.NEGATIVE_INFINITY, timer: null, unsent: false });
  const stopPresence = useCallback(() => {
    if (presence.current.timer) clearTimeout(presence.current.timer);
    presence.current = { sentAt: Number.NEGATIVE_INFINITY, timer: null, unsent: false };
  }, []);
  const sendPresence = useCallback(
    (askId: string) => {
      const current = heldRef.current;
      if (current.askId !== askId) return;
      if (presence.current.timer) clearTimeout(presence.current.timer);
      const sent = commands.presence(
        askId,
        current.entries.map((entry) => entry.choice),
      );
      presence.current = {
        sentAt: sent ? Date.now() : presence.current.sentAt,
        timer: null,
        unsent: !sent,
      };
    },
    [commands],
  );
  /** Report the held draft now, or once the interval since the last report has passed. */
  const reportPresence = useCallback(
    (askId: string) => {
      const wait = presence.current.sentAt + PRESENCE_INTERVAL_MS - Date.now();
      if (wait <= 0) sendPresence(askId);
      else presence.current.timer ??= setTimeout(() => sendPresence(askId), wait);
    },
    [sendPresence],
  );
  // Send what is owed (a report waiting on the interval, or one the socket dropped) rather than lose it.
  const flushPresence = useCallback(() => {
    const askId = heldRef.current.askId;
    if (askId !== null && (presence.current.timer || presence.current.unsent)) sendPresence(askId);
  }, [sendPresence]);
  useEffect(() => {
    window.addEventListener("pagehide", flushPresence);
    const unsubscribe = commands.onConnected(() => {
      if (presence.current.unsent) flushPresence();
    });
    return () => {
      window.removeEventListener("pagehide", flushPresence);
      unsubscribe();
      flushPresence();
    };
  }, [commands, flushPresence]);

  useEffect(() => {
    const current = heldRef.current;
    const ended = tracked?.resolution != null;
    if (current.askId !== null && (ended || (openId !== null && openId !== current.askId))) {
      const words = unsettledWords(current, tracked);
      if (words) composer.current?.appendText(words);
      stopPresence();
      write(NONE);
      return;
    }
    if (openId !== null && current.askId === null && open) {
      write({ askId: openId, ...seedDraft(open.ask) });
    }
  }, [composer, open, openId, stopPresence, tracked, write]);

  if (!open) return null;
  const draft = held.askId === open.ask.id ? held : seedDraft(open.ask);
  return (
    <AskTakeover
      open={open}
      draft={draft}
      refused={refusedAsk === open.ask.id}
      onDraftChange={(next) => {
        setRefusedAsk(null);
        write({ askId: open.ask.id, ...next });
        reportPresence(open.ask.id);
      }}
      onSettle={() => commands.settle(open.ask.id)}
      onAnswer={(answer) => {
        // The answer carries the draft; a trailing report would only repeat it.
        stopPresence();
        setRefusedAsk(null);
        const askId = open.ask.id;
        void commands.answer(askId, answer).then((result) => {
          const current = heldRef.current;
          if (result.kind !== "invalid_answer") return;
          setRefusedAsk(askId);
          // A draft the writer never changed isn't held yet; the seeded one is what was sent.
          if (result.questionIndex !== undefined && current.askId === askId)
            write({ ...current, step: result.questionIndex });
        });
      }}
    />
  );
}

/** The draft a takeover starts from: the answers the server holds for the ask, else none. */
function seedDraft(ask: ThreadAsk): QuestionDraft {
  const count = ask.kind === "question" ? ask.payload.questions.length : 0;
  const held = ask.draftAnswers ?? [];
  const entries = Array.from({ length: count }, (_, index) => {
    const choice = held[index] ?? null;
    return { choice, words: choice?.kind === "text" ? choice.text : "" };
  });
  // Resume at the first question still open.
  const open = entries.findIndex((entry) => entry.choice === null);
  return { step: open < 0 ? 0 : open, entries };
}

/** Each question's typed words that its outcome doesn't hold, one per line; empty when none. */
function unsettledWords(draft: QuestionDraft, ask: ThreadAsk | undefined): string {
  const outcome =
    ask?.resolution?.kind === "answers" || ask?.resolution?.kind === "timeout"
      ? ask.resolution.answers
      : [];
  return draft.entries
    .flatMap((entry, index) => {
      const words = entry.words.trim();
      const kept = outcome[index];
      return words && !(kept?.kind === "text" && kept.text === words) ? [words] : [];
    })
    .join("\n");
}
