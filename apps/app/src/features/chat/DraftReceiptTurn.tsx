/** DraftReceiptTurn — muted one-line transcript receipt for finalized AI drafts. */
import { t } from "@lingui/core/macro";
import {
  isDraftAcceptTurnRequestParams,
  isDraftRejectTurnRequestParams,
} from "@meridian/contracts/drafts";
import { blockPlainText, type Turn } from "@meridian/contracts/protocol";
import { memo } from "react";

export type DraftReceiptKind = "accept" | "reject";

export type DraftReceiptTurnProps = {
  turn: Turn;
  kind: DraftReceiptKind;
};

function DraftReceiptTurnComponent({ turn, kind }: DraftReceiptTurnProps) {
  const text = draftTurnText(turn, fallbackText(kind));

  return (
    <article
      className="mb-10"
      data-turn-id={turn.id}
      data-turn-role="user"
      data-turn-kind={kind === "accept" ? "draft-accept" : "draft-reject"}
      aria-label={text}
    >
      <p className="truncate text-[12.5px] text-muted-foreground italic">{text}</p>
    </article>
  );
}

export const DraftReceiptTurn = memo(
  DraftReceiptTurnComponent,
  (prev, next) => prev.turn === next.turn && prev.kind === next.kind,
);
DraftReceiptTurn.displayName = "DraftReceiptTurn";

export function draftReceiptKind(turn: Turn): DraftReceiptKind | null {
  if (isDraftAcceptTurnRequestParams(turn.requestParams)) return "accept";
  if (isDraftRejectTurnRequestParams(turn.requestParams)) return "reject";
  return null;
}

function fallbackText(kind: DraftReceiptKind): string {
  return kind === "accept" ? t`You accepted this draft` : t`You discarded this draft`;
}

function draftTurnText(turn: Turn, fallback: string): string {
  const block = turn.blocks[0];
  if (!block) return fallback;
  return block.textContent ?? blockPlainText(block.blockType, block.content) ?? fallback;
}
