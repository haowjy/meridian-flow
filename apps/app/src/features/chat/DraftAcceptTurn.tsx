/** DraftAcceptTurn — user-attributed transcript event for accepting an AI draft. */
import { t } from "@lingui/core/macro";
import { isDraftAcceptTurnRequestParams } from "@meridian/contracts/drafts";
import { blockPlainText, type Turn } from "@meridian/contracts/protocol";
import { memo } from "react";

import { DraftUndoFooter } from "./DraftUndoFooter";

export type DraftAcceptTurnProps = {
  threadId?: string;
  turn: Turn;
};

function DraftAcceptTurnComponent({ threadId, turn }: DraftAcceptTurnProps) {
  const resolvedThreadId = threadId ?? turn.threadId;
  const params = isDraftAcceptTurnRequestParams(turn.requestParams) ? turn.requestParams : null;
  const text = draftTurnText(turn, t`You accepted this draft`);

  return (
    <article
      className="mb-10"
      data-turn-id={turn.id}
      data-turn-role="user"
      data-turn-kind="draft-accept"
      aria-label={text}
    >
      {params ? (
        <DraftUndoFooter
          threadId={resolvedThreadId}
          documentId={params.documentId}
          documentName={params.documentName ?? null}
          draftId={params.draftId}
          variant="accept"
        />
      ) : (
        <p className="text-[12.5px] font-medium text-ink-muted">{text}</p>
      )}
    </article>
  );
}

export const DraftAcceptTurn = memo(
  DraftAcceptTurnComponent,
  (prev, next) => prev.threadId === next.threadId && prev.turn === next.turn,
);
DraftAcceptTurn.displayName = "DraftAcceptTurn";

function draftTurnText(turn: Turn, fallback: string): string {
  const block = turn.blocks[0];
  if (!block) return fallback;
  return block.textContent ?? blockPlainText(block.blockType, block.content) ?? fallback;
}
