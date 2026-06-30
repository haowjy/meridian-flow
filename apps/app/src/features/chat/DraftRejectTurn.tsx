/** DraftRejectTurn — user-attributed transcript event for discarding an AI draft. */
import { t } from "@lingui/core/macro";
import { isDraftRejectTurnRequestParams } from "@meridian/contracts/drafts";
import { blockPlainText, type Turn } from "@meridian/contracts/protocol";
import { memo } from "react";

import { DraftUndoFooter } from "./DraftUndoFooter";

function DraftRejectTurnComponent({ turn }: { turn: Turn }) {
  const params = isDraftRejectTurnRequestParams(turn.requestParams) ? turn.requestParams : null;
  const text = draftTurnText(turn, t`You discarded this draft`);
  return (
    <article
      className="mb-10"
      data-turn-id={turn.id}
      data-turn-role="user"
      data-turn-kind="draft-reject"
      aria-label={text}
    >
      {params ? (
        <DraftUndoFooter
          threadId={turn.threadId}
          documentId={params.documentId}
          documentName={params.documentName ?? null}
          draftId={params.draftId}
          variant="reject"
        />
      ) : (
        <p className="text-[12.5px] font-medium text-ink-muted">{text}</p>
      )}
    </article>
  );
}

export const DraftRejectTurn = memo(
  DraftRejectTurnComponent,
  (prev, next) => prev.turn === next.turn,
);
DraftRejectTurn.displayName = "DraftRejectTurn";

function draftTurnText(turn: Turn, fallback: string): string {
  const block = turn.blocks[0];
  if (!block) return fallback;
  return block.textContent ?? blockPlainText(block.blockType, block.content) ?? fallback;
}
