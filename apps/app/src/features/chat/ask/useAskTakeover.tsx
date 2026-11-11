/**
 * The chat composer's open-ask mode: the takeover to draw in the box's place, and the writer's
 * draft of the answers (which question they're on, each one's choice and typed words). The draft
 * outlives the takeover, which also hides while this device's answer sends or settles, so a failed
 * send reopens with every answer in place. A refused answer isn't a failed send: it shows a
 * message with no Retry until the writer changes something.
 *
 * Nothing typed is lost: when the ask ends, words that aren't in how it ended (left in a field
 * beside a picked option, typed when the ask timed out and so not sent, or sent but beaten by
 * another resolution) are added to the composer
 * draft once. Closure follows the ask's lifecycle, not the takeover. The writer's draft is kept
 * in this tab's session storage, one per chat, so leaving the chat or reloading keeps the words;
 * an ask that ended meanwhile closes when the chat opens again.
 *
 * A takeover the writer hasn't touched (a reload, another device, coming back to a chat) shows
 * the answers the server holds for the ask (`draftAnswers`), the ones a timeout would use, and
 * follows them as newer ones arrive: a chat left open re-reads them on return. The draft becomes
 * the writer's own at their first change, and no later `ask.updated` replaces it. With two tabs
 * open, the last report to reach the server wins, and a delayed re-send can replace a newer answer from another device; a tab that only sees activity never
 * sends its draft. A send the server refuses as `invalid_answer` moves the draft to
 * the question it names.
 *
 * While a question ask is open, any activity on the page (pointer, keys, wheel, touch) and every
 * change to the draft report it to the server as `ask.presence` (`presence-reporter.ts`), which
 * keeps the idle clock from running while the writer reads. A report carries the answers only
 * while the draft is `owed` (a choice changed and the server hasn't echoed it), so plain activity
 * moves the clock without replacing the answers the server holds, and Back or Next, which change
 * no choice, never do. An answer holds its draft without reporting it: the answer carries it, and
 * the ask is no longer open here. If the send fails and the takeover reopens, answers still owed
 * go out with the next activity.
 */
import {
  type DraftAnswers,
  questionAnswerSchema,
  type ThreadAsk,
} from "@meridian/contracts/threads";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browserRecord, isRecord } from "@/client/storage/browser-record";
import { useOpenAsk, useThreadStore } from "@/client/stores";
import type { ComposerHandle } from "@/components/app/composer";
import { AskTakeover, type QuestionDraft } from "./AskTakeover";
import { createPresenceReporter } from "./presence-reporter";
import { useAnswerAsk } from "./useAnswerAsk";

/**
 * `owed`: the choices changed here and the server has not echoed them in `draftAnswers` yet.
 * It lives with the draft (and in session storage), so a dropped frame, a failed send, leaving
 * the chat or a reload cannot forget what the server is missing; the next connect, mount or
 * activity sends it again.
 */
type HeldDraft = QuestionDraft & { askId: string | null; owed: boolean };

/** Page activity that shows the writer is there. Not `scroll`: the page scrolls itself too. */
const ACTIVITY_EVENTS = [
  "pointermove",
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
  "touchmove",
] as const;

const NONE: HeldDraft = { askId: null, step: 0, entries: [], owed: false };

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
  // The question ask this takeover shows now; null while an answer sends, once it ends, and for
  // a permission ask (the server refuses presence for those).
  const askRef = useRef<ThreadAsk | null>(null);
  askRef.current = open?.ask.kind === "question" ? open.ask : null;
  const presence = useMemo(
    () =>
      createPresenceReporter(commands.presence, () => {
        const ask = askRef.current;
        if (!ask) return null;
        const draft = heldRef.current;
        if (!draft.owed || draft.askId !== ask.id) return { askId: ask.id };
        return { askId: ask.id, answers: draft.entries.map((entry) => entry.choice) };
      }),
    [commands],
  );
  const questionOpen = askRef.current !== null;
  useEffect(() => {
    if (!questionOpen) return;
    const options = { capture: true, passive: true };
    const report = () => presence.report();
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, report, options);
    return () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, report, options);
    };
  }, [presence, questionOpen]);
  // The server echoes every answer-carrying report, so its echo of the choices is the ack. Runs
  // before the report effect so a mount with the echo already in the store doesn't re-send.
  useEffect(() => {
    const current = heldRef.current;
    if (
      current.owed &&
      tracked?.id === current.askId &&
      sameChoices(
        current.entries.map((entry) => entry.choice),
        tracked.draftAnswers ?? [],
      )
    )
      write({ ...current, owed: false });
  }, [tracked, held.owed, write]);
  // A draft with answers the server lacks (a reload, a failed send that reopened the takeover)
  // reports as soon as its ask is open here.
  useEffect(() => {
    if (questionOpen && held.owed) presence.report();
  }, [presence, questionOpen, held.owed]);
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
  // Whether the server lacks answers once `next` is the draft: it already did, or a choice changed.
  const owedAfter = (next: QuestionDraft) => {
    const mine = held.askId === open.ask.id;
    const base = mine ? held : seedDraft(open.ask);
    const choices = (of: QuestionDraft) => of.entries.map((entry) => entry.choice);
    return (mine && held.owed) || !sameChoices(choices(base), choices(next));
  };
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
        write({ askId: open.ask.id, ...next, owed: owedAfter(next) });
        presence.report();
      }}
      onSettle={() => commands.settle(open.ask.id)}
      onAnswer={(answer, sent) => {
        // The answer carries the draft; a report waiting on its interval would only repeat it.
        presence.stop();
        setRefusedAsk(null);
        const askId = open.ask.id;
        // Held before it sends, so a failed send reopens with every answer picked.
        if (sent) write({ askId, ...sent, owed: owedAfter(sent) });
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
        owed: value.owed === true,
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

/** Whether two lists of choices are the same answers; a missing choice is null (no trailing-null drift). */
function sameChoices(a: DraftAnswers, b: DraftAnswers): boolean {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const x = a[index] ?? null;
    const y = b[index] ?? null;
    if (x === null || y === null) {
      if (x !== y) return false;
    } else if (x.kind !== y.kind) return false;
    else if (x.kind === "option" && x.label !== (y as typeof x).label) return false;
    else if (x.kind === "text" && x.text !== (y as typeof x).text) return false;
  }
  return true;
}
