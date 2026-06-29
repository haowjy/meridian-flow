/** DraftAcceptTurn — user-attributed transcript event for accepting an AI draft. */
import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
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

  return (
    <article
      className="mb-10"
      data-turn-id={turn.id}
      data-turn-role="user"
      data-turn-kind="draft-accept"
      aria-label={t`You accepted this draft`}
    >
      {liveLineageDocuments.length > 0 ? (
        <TurnChangeFooter
          threadId={resolvedThreadId}
          turn={turn}
          documents={liveLineageDocuments}
          variant="draftAccept"
        />
      ) : (
        <p className="text-[12.5px] font-medium text-ink-muted">{t`You accepted this draft`}</p>
      )}
    </article>
  );
}

export const DraftAcceptTurn = memo(
  DraftAcceptTurnComponent,
  (prev, next) => prev.threadId === next.threadId && prev.turn === next.turn,
);
DraftAcceptTurn.displayName = "DraftAcceptTurn";
