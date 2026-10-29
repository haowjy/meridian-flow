/**
 * The chat composer's open-ask mode: the takeover to draw in the box's place, and the writer's
 * draft of the answers (which question they're on, each one's choice and typed words). The draft
 * outlives the takeover, which also hides while this device's answer sends or settles, so a failed
 * send reopens with every answer in place. A refused answer isn't a failed send: it shows a
 * message with no Retry until the writer changes something.
 *
 * Nothing typed is lost: when the ask ends, words that aren't in how it ended (left in a field
 * beside a picked option, or sent but beaten by another resolution) are added to the composer
 * draft once. Closure follows the ask's lifecycle, not the takeover. The writer's draft is kept
 * in this tab's session storage, one per chat, so leaving the chat or reloading keeps the words;
 * an ask that ended meanwhile closes when the chat opens again.
 *
 * A takeover the writer hasn't touched (a reload, another device, coming back to a chat) shows
 * the answers the server holds for the ask (`draftAnswers`), the ones a timeout would use, and
 * follows them as newer ones arrive: a chat left open re-reads them on return. The draft becomes
 * the writer's own at their first change, and no later `ask.updated` replaces it. With two tabs
 * open the last one to report wins. A send the server refuses as `invalid_answer` moves the draft to
 * the question it names.
 *
 * While the writer works on a question, the draft goes to the server as `ask.presence`
 * (`presence-reporter.ts`). An answer holds its draft without reporting it: the answer carries it.
 */
import { questionAnswerSchema, type ThreadAsk } from "@meridian/contracts/threads";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browserRecord, isRecord } from "@/client/storage/browser-record";
import { useOpenAsk, useThreadStore } from "@/client/stores";
import type { ComposerHandle } from "@/components/app/composer";
import { AskTakeover, type QuestionDraft } from "./AskTakeover";
import { createPresenceReporter } from "./presence-reporter";
import { useAnswerAsk } from "./useAnswerAsk";

type HeldDraft = QuestionDraft & { askId: string | null };

const NONE: HeldDraft = { askId: null, step: 0, entries: [] };

export function useAskTakeover(
  accountId: string,
  threadId: string,
  composer: RefObject<ComposerHandle | null>,
) {
  const open = useOpenAsk(threadId);
  const commands = useAnswerAsk(threadId);
  const openId = open?.ask.id ?? null;
  // ChatView is keyed by chat, so the account and chat are fixed for this hook's life.
  const [stored] = useState(() => heldRecord(accountId, threadId));
  const [held, setHeld] = useState<HeldDraft>(() => stored.read() ?? NONE);
  // The ref is the truth for the effect and the presence timer: it changes with each write,
  // before any render the answer's store update causes.
  const heldRef = useRef(held);
  const write = useCallback(
    (next: HeldDraft) => {
      heldRef.current = next;
      setHeld(next);
      stored.write(next.askId === null ? undefined : next);
    },
    [stored],
  );
  // The ask whose last answer the server refused; any change to its draft clears it.
  const [refusedAsk, setRefusedAsk] = useState<string | null>(null);
  const tracked = useThreadStore((state) =>
    held.askId === null ? undefined : state.syncedByThread[threadId]?.asks.byId.get(held.askId),
  );
  const presence = useMemo(
    () =>
      createPresenceReporter(commands.presence, () => {
        const { askId, entries } = heldRef.current;
        return askId === null ? null : { askId, answers: entries.map((entry) => entry.choice) };
      }),
    [commands],
  );
  useEffect(() => {
    window.addEventListener("pagehide", presence.flush);
    const unsubscribe = commands.onConnected(presence.flush);
    return () => {
      window.removeEventListener("pagehide", presence.flush);
      unsubscribe();
      presence.flush();
    };
  }, [commands, presence]);

  useEffect(() => {
    const current = heldRef.current;
    const ended = tracked?.resolution != null;
    if (current.askId !== null && (ended || (openId !== null && openId !== current.askId))) {
      const words = unsettledWords(current, tracked);
      if (words) composer.current?.appendText(words);
      presence.stop();
      write(NONE);
    }
  }, [composer, openId, presence, tracked, write]);

  if (!open) return null;
  const draft =
    open.ask.kind !== "question"
      ? undefined
      : held.askId === open.ask.id
        ? held
        : seedDraft(open.ask);
  return (
    <AskTakeover
      open={open}
      draft={draft}
      refused={refusedAsk === open.ask.id}
      onDraftChange={(next) => {
        setRefusedAsk(null);
        write({ askId: open.ask.id, ...next });
        presence.report();
      }}
      onSettle={() => commands.settle(open.ask.id)}
      onAnswer={(answer, sent) => {
        // The answer carries the draft; a trailing report would only repeat it.
        presence.stop();
        setRefusedAsk(null);
        const askId = open.ask.id;
        // Held before it sends, so a failed send reopens with every answer picked.
        if (sent) write({ askId, ...sent });
        void commands.answer(askId, answer).then((result) => {
          const current = heldRef.current;
          if (result.kind !== "invalid_answer") return;
          setRefusedAsk(askId);
          if (result.questionIndex !== undefined) write({ ...current, step: result.questionIndex });
        });
      }}
    />
  );
}

function heldRecord(accountId: string, threadId: string) {
  return browserRecord<HeldDraft>(
    "session",
    {
      key: `meridian:ask-draft:v1:${JSON.stringify([accountId, threadId])}`,
      version: 1,
      accountId,
    },
    (value) => {
      if (!isRecord(value) || typeof value.askId !== "string") return undefined;
      const { step, entries } = value;
      if (
        !Number.isInteger(step) ||
        !Array.isArray(entries) ||
        (step as number) < 0 ||
        (step as number) >= entries.length
      )
        return undefined;
      const parsed = entries.map((entry) => {
        if (!isRecord(entry) || typeof entry.words !== "string") return null;
        const choice = questionAnswerSchema.nullable().safeParse(entry.choice);
        return choice.success ? { choice: choice.data, words: entry.words } : null;
      });
      if (parsed.some((entry) => entry === null)) return undefined;
      return {
        askId: value.askId,
        step: step as number,
        entries: parsed as QuestionDraft["entries"],
      };
    },
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
