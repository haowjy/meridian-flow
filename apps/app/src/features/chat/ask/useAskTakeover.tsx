/**
 * The chat composer's open-ask mode: the takeover to draw in the box's place, and the own-answer
 * field's text. Whatever the field still holds when the ask closes (answered elsewhere, timed out,
 * or answered here with an option) is added to the composer draft, so nothing typed is lost.
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useOpenAsk } from "@/client/stores";
import type { ComposerHandle } from "@/components/app/composer";
import { AskTakeover } from "./AskTakeover";
import { useAnswerAsk } from "./useAnswerAsk";

export function useAskTakeover(
  threadId: string,
  agentName: string,
  composer: RefObject<ComposerHandle | null>,
) {
  const open = useOpenAsk(threadId);
  const answer = useAnswerAsk(threadId);
  const openId = open?.ask.id ?? null;
  // A failed own-words answer comes back into the field, where the rule above keeps it.
  const failedText = open?.failed?.answer.kind === "text" ? open.failed.answer.text : null;
  const [field, setField] = useState({ askId: openId, text: failedText ?? "" });
  // The ref is the field's truth for the close effect: it changes with each write, before any
  // render the answer's store update causes.
  const fieldRef = useRef(field);
  const write = useCallback((next: { askId: string | null; text: string }) => {
    fieldRef.current = next;
    setField(next);
  }, []);

  useEffect(() => {
    const held = fieldRef.current;
    if (held.askId === openId) return;
    if (held.text.trim()) composer.current?.appendText(held.text);
    write({ askId: openId, text: failedText ?? "" });
  }, [composer, openId, failedText, write]);

  if (!open) return null;
  return (
    <AskTakeover
      open={open}
      agentName={agentName}
      text={field.askId === open.ask.id ? field.text : ""}
      onTextChange={(text) => write({ askId: open.ask.id, text })}
      onAnswer={(next) => {
        // Sent words leave the field; anything else typed there stays for the draft.
        if (next.kind === "text") write({ askId: open.ask.id, text: "" });
        answer(open.ask.id, next);
      }}
    />
  );
}
