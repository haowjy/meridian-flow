import { type Turn, userMessageBlocksFromTurn } from "@meridian/contracts/protocol";
import {
  type ChatReferenceScope,
  chatReferenceResolver,
  composerDocFromHandedBack,
} from "@meridian/thread-client";
import type { RefObject } from "react";
import { composerSessionDraft } from "@/client/chat-submissions/composer-drafts";
import type { ComposerHandle } from "@/features/chat/composer";
import { useCommittedEvent } from "./useCommittedEvent";

export function useEditStopped(input: {
  threadId: string;
  accountId: string;
  turns: readonly Turn[];
  scope: ChatReferenceScope | null;
  composer: RefObject<ComposerHandle | null>;
}): (turnId: string) => void {
  const { threadId, accountId, turns, scope, composer } = input;
  return useCommittedEvent((turnId: string) => {
    const turn = turns.find((candidate) => candidate.id === turnId);
    if (!turn) return;
    const resolve = scope ? chatReferenceResolver(scope) : () => null;
    const doc = composerDocFromHandedBack(
      [{ userTurnId: turnId, blocks: userMessageBlocksFromTurn(turn.blocks) }],
      resolve,
    );
    if (!composerSessionDraft(accountId, { kind: "chat", id: threadId }).putBack(doc)) return;
    requestAnimationFrame(() => composer.current?.focus());
  });
}
