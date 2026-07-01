/** DraftRejectTurn — user-attributed transcript receipt for discarding an AI draft. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { isDraftRejectTurnRequestParams } from "@meridian/contracts/drafts";
import { blockPlainText, type Turn } from "@meridian/contracts/protocol";
import { FileText } from "lucide-react";
import { memo } from "react";

import { relativeTime } from "@/features/project/relative-time";

import { ComponentResolvedSummary } from "./ComponentCard";

function DraftRejectTurnComponent({ turn }: { turn: Turn }) {
  const params = isDraftRejectTurnRequestParams(turn.requestParams) ? turn.requestParams : null;
  const text = draftTurnText(turn, t`You discarded this draft`);
  const documentName = params?.documentName ?? t`Untitled document`;
  const age = relativeTime(turn.createdAt, Date.now());

  return (
    <article
      className="mb-10"
      data-turn-id={turn.id}
      data-turn-role="user"
      data-turn-kind="draft-reject"
      aria-label={text}
    >
      {params ? (
        <ComponentResolvedSummary
          icon={FileText}
          title={<Trans>Discarded</Trans>}
          value={documentName}
          statusLabel={<Trans>discarded {age} ago</Trans>}
          className="mb-0"
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
