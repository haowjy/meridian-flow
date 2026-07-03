/** DraftAcceptTurn — muted user-attributed transcript receipt for accepting an AI draft. */
import type { Turn } from "@meridian/contracts/protocol";
import { memo } from "react";

import { DraftReceiptTurn } from "./DraftReceiptTurn";

export type DraftAcceptTurnProps = {
  threadId?: string;
  turn: Turn;
};

function DraftAcceptTurnComponent({ turn }: DraftAcceptTurnProps) {
  return <DraftReceiptTurn turn={turn} kind="accept" />;
}

export const DraftAcceptTurn = memo(
  DraftAcceptTurnComponent,
  (prev, next) => prev.threadId === next.threadId && prev.turn === next.turn,
);
DraftAcceptTurn.displayName = "DraftAcceptTurn";
