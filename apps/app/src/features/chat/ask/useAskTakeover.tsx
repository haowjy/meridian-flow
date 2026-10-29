/**
 * The chat composer's open-ask mode: the takeover to draw in the box's place, and the words the
 * writer typed for the ask. Nothing typed is lost: when the ask ends, text still in the answer
 * field, and sent words that lost to another resolution, are added to the composer draft once.
 *
 * Closure follows the ask's lifecycle, not the takeover: the takeover also hides while this
 * device's answer sends or settles, and the words must wait for how the ask actually ended.
 */
import type { ThreadAsk } from "@meridian/contracts/threads";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useOpenAsk, useThreadStore } from "@/client/stores";
import type { ComposerHandle } from "@/components/app/composer";
import { AskTakeover } from "./AskTakeover";
import { useAnswerAsk } from "./useAnswerAsk";

/** The words held for one ask: still in the field, and sent but not yet known to have won. */
type HeldWords = { askId: string | null; field: string; sent: string | null };

const NONE: HeldWords = { askId: null, field: "", sent: null };

export function useAskTakeover(threadId: string, composer: RefObject<ComposerHandle | null>) {
  const open = useOpenAsk(threadId);
  const commands = useAnswerAsk(threadId);
  const openId = open?.ask.id ?? null;
  const [held, setHeld] = useState<HeldWords>(NONE);
  // The ref is the truth for the effect: it changes with each write, before any render the
  // answer's store update causes.
  const heldRef = useRef(held);
  const write = useCallback((next: HeldWords) => {
    heldRef.current = next;
    setHeld(next);
  }, []);
  const tracked = useThreadStore((state) =>
    held.askId === null ? undefined : state.syncedByThread[threadId]?.asks.byId.get(held.askId),
  );

  useEffect(() => {
    const current = heldRef.current;
    const ended = tracked?.resolution != null;
    if (current.askId !== null && (ended || (openId !== null && openId !== current.askId))) {
      const lost = current.sent !== null && !wonWith(tracked, current.sent);
      const words = [current.field.trim(), lost ? current.sent : null].filter(Boolean).join("\n");
      if (words) composer.current?.appendText(words);
      write(NONE);
      return;
    }
    if (openId !== null && current.askId === null) {
      write({ askId: openId, field: "", sent: null });
    }
  }, [composer, openId, tracked, write]);

  if (!open) return null;
  return (
    <AskTakeover
      open={open}
      text={held.askId === open.ask.id ? held.field : ""}
      onTextChange={(text) => write({ ...heldRef.current, askId: open.ask.id, field: text })}
      onSettle={() => commands.settle(open.ask.id)}
      onAnswer={(next) => {
        // Sent words leave the field but stay held until the ask says whether they won.
        if (next.kind === "answers")
          write({ askId: open.ask.id, field: "", sent: ownWords(next.answers) });
        commands.answer(open.ask.id, next);
      }}
    />
  );
}

/** The own words in an answer set, one per line; null when it has none. */
function ownWords(answers: readonly { kind: string; text?: string }[]): string | null {
  const words = answers.flatMap((answer) =>
    answer.kind === "text" && answer.text ? [answer.text] : [],
  );
  return words.length > 0 ? words.join("\n") : null;
}

/** Whether the ask ended with exactly these words of this device's. */
function wonWith(ask: ThreadAsk | undefined, words: string): boolean {
  return ask?.resolution?.kind === "answers" && ownWords(ask.resolution.answers) === words;
}
