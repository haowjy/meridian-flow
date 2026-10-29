/**
 * The chat composer's open-ask mode: the takeover to draw in the box's place, and the writer's
 * draft of the answers (which question they're on, each one's choice and typed words). The draft
 * outlives the takeover, which also hides while this device's answer sends or settles, so a failed
 * send reopens with every answer in place.
 *
 * Nothing typed is lost: when the ask ends, words that aren't in how it ended (left in a field
 * beside a picked option, or sent but beaten by another resolution) are added to the composer
 * draft once. Closure follows the ask's lifecycle, not the takeover.
 *
 * While the writer works on a question, the draft goes to the server as `ask.presence`, at most
 * once per `PRESENCE_INTERVAL_MS`, so the idle deadline stays off and a walk-away keeps what
 * they chose.
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
  const tracked = useThreadStore((state) =>
    held.askId === null ? undefined : state.syncedByThread[threadId]?.asks.byId.get(held.askId),
  );
  const presence = useRef<{ sentAt: number; timer: ReturnType<typeof setTimeout> | null }>({
    sentAt: Number.NEGATIVE_INFINITY,
    timer: null,
  });
  const stopPresence = useCallback(() => {
    if (presence.current.timer) clearTimeout(presence.current.timer);
    presence.current = { sentAt: Number.NEGATIVE_INFINITY, timer: null };
  }, []);
  /** Report the held draft now, or once the interval since the last report has passed. */
  const reportPresence = useCallback(
    (askId: string) => {
      const send = () => {
        const current = heldRef.current;
        if (current.askId !== askId) return;
        presence.current = { sentAt: Date.now(), timer: null };
        commands.presence(
          askId,
          current.entries.map((entry) => entry.choice),
        );
      };
      const wait = presence.current.sentAt + PRESENCE_INTERVAL_MS - Date.now();
      if (wait <= 0) send();
      else presence.current.timer ??= setTimeout(send, wait);
    },
    [commands],
  );
  useEffect(() => stopPresence, [stopPresence]);

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
      write({ askId: openId, ...emptyDraft(open.ask) });
    }
  }, [composer, open, openId, stopPresence, tracked, write]);

  if (!open) return null;
  const draft = held.askId === open.ask.id ? held : emptyDraft(open.ask);
  return (
    <AskTakeover
      open={open}
      draft={draft}
      onDraftChange={(next) => {
        write({ askId: open.ask.id, ...next });
        reportPresence(open.ask.id);
      }}
      onSettle={() => commands.settle(open.ask.id)}
      onAnswer={(answer) => {
        // The answer carries the draft; a trailing report would only repeat it.
        stopPresence();
        commands.answer(open.ask.id, answer);
      }}
    />
  );
}

function emptyDraft(ask: ThreadAsk): QuestionDraft {
  const count = ask.kind === "question" ? ask.payload.questions.length : 0;
  return { step: 0, entries: Array.from({ length: count }, () => ({ choice: null, words: "" })) };
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
