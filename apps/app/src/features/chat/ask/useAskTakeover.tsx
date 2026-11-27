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

type HeldDraft = QuestionDraft & { askId: string | null; owed: boolean };

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
  const [stored] = useState(() => heldRecord(accountId, threadId));
  const [held, setHeld] = useState<HeldDraft>(() => stored.read() ?? NONE);
  const heldRef = useRef(held);
  const write = useCallback(
    (next: HeldDraft) => {
      heldRef.current = next;
      setHeld(next);
      stored.write(next.askId === null ? undefined : next);
    },
    [stored],
  );
  const [refusedAsk, setRefusedAsk] = useState<string | null>(null);
  const tracked = useThreadStore((state) =>
    held.askId === null ? undefined : state.syncedByThread[threadId]?.asks.byId.get(held.askId),
  );
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
  // This effect must run before the report effect; the server echo is the ack, so clearing owed first stops a mount that already has the echo from re-sending.
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
        presence.stop();
        setRefusedAsk(null);
        const askId = open.ask.id;
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

function seedDraft(ask: ThreadAsk): QuestionDraft {
  const count = ask.kind === "question" ? ask.payload.questions.length : 0;
  const held = ask.draftAnswers ?? [];
  const entries = Array.from({ length: count }, (_, index) => {
    const choice = held[index] ?? null;
    return { choice, words: choice?.kind === "text" ? choice.text : "" };
  });
  const open = entries.findIndex((entry) => entry.choice === null);
  return { step: Math.max(open, 0), entries };
}

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
