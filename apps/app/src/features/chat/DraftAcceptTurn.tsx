/** DraftAcceptTurn — user-attributed transcript event for accepting an AI draft. */
import { t } from "@lingui/core/macro";
import { blockPlainText, type Turn } from "@meridian/contracts/protocol";
import { memo } from "react";

import { useTurnLiveLineage } from "@/client/query/useTurnLiveLineage";
import { TurnChangeFooter } from "./TurnChangeFooter";

export type DraftAcceptTurnProps = {
  threadId?: string;
  turn: Turn;
};

function DraftAcceptTurnComponent({ threadId, turn }: DraftAcceptTurnProps) {
  const resolvedThreadId = threadId ?? turn.threadId;
  const liveLineage = useTurnLiveLineage(resolvedThreadId, turn.id, { enabled: true });
  const liveLineageDocuments = liveLineage.documents ?? [];
  const text = draftTurnText(turn, t`You accepted this draft`);

  return (
    <article
      className="mb-10"
      data-turn-id={turn.id}
      data-turn-role="user"
      data-turn-kind="draft-accept"
      aria-label={text}
    >
      {liveLineageDocuments.length > 0 ? (
        <TurnChangeFooter
          threadId={resolvedThreadId}
          turn={turn}
          documents={liveLineageDocuments}
          variant="draftAccept"
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
