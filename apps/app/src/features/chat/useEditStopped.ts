/**
 * useEditStopped — Edit on the writer's message above a reply they stopped: the message's words,
 * chips included, go above whatever the message box holds, the way a hand-back's do, and the box
 * takes focus. The message and the stopped reply stay in the transcript.
 */
import { type Turn, userMessageBlocksFromTurn } from "@meridian/contracts/protocol";
import {
  type ChatReferenceScope,
  chatReferenceResolver,
  composerDocFromHandedBack,
} from "@meridian/thread-client";
import type { RefObject } from "react";
import { composerSessionDraft } from "@/client/composer-drafts";
import type { ComposerHandle } from "@/components/app/composer";
import { useCommittedEvent } from "./useCommittedEvent";

export function useEditStopped(input: {
  threadId: string;
  accountId: string;
  turns: readonly Turn[];
  /** Where the message's references live; null until the chat has loaded. */
  scope: ChatReferenceScope | null;
  composer: RefObject<ComposerHandle | null>;
}): (turnId: string) => void {
  const { threadId, accountId, turns, scope, composer } = input;
  return useCommittedEvent((turnId: string) => {
    const turn = turns.find((candidate) => candidate.id === turnId);
    if (!turn) return;
    // Without the chat's facts a reference comes back as its link text.
    const resolve = scope ? chatReferenceResolver(scope) : () => null;
    const doc = composerDocFromHandedBack(
      [{ userTurnId: turnId, blocks: userMessageBlocksFromTurn(turn.blocks) }],
      resolve,
    );
    if (!composerSessionDraft(accountId, { kind: "chat", id: threadId }).putBack(doc)) return;
    // The box remounts on the new draft; focus the one that mounted.
    requestAnimationFrame(() => composer.current?.focus());
  });
}
