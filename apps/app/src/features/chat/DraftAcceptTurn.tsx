/** DraftAcceptTurn — user-attributed transcript receipt for accepting an AI draft. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { isDraftAcceptTurnRequestParams } from "@meridian/contracts/drafts";
import { blockPlainText, type Turn } from "@meridian/contracts/protocol";
import { FileText } from "lucide-react";
import { memo } from "react";

import { relativeTime } from "@/features/project/relative-time";

import { ComponentResolvedSummary } from "./ComponentCard";

export type DraftAcceptTurnProps = {
  threadId?: string;
  turn: Turn;
};

function DraftAcceptTurnComponent({ turn }: DraftAcceptTurnProps) {
  const params = isDraftAcceptTurnRequestParams(turn.requestParams) ? turn.requestParams : null;
  const text = draftTurnText(turn, t`You accepted this draft`);
  const documentName = params?.documentName ?? t`Untitled document`;
  const age = relativeTime(turn.createdAt, Date.now());

  return (
    <article
      className="mb-10"
      data-turn-id={turn.id}
      data-turn-role="user"
      data-turn-kind="draft-accept"
      aria-label={text}
    >
      {params ? (
        <ComponentResolvedSummary
          icon={FileText}
          title={<Trans>Applied to chapter</Trans>}
          value={documentName}
          statusLabel={<Trans>applied {age} ago</Trans>}
          className="mb-0"
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
