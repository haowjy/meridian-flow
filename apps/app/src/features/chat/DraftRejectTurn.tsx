/** DraftRejectTurn — muted user-attributed transcript receipt for discarding an AI draft. */
import type { Turn } from "@meridian/contracts/protocol";
import { memo } from "react";

import { DraftReceiptTurn } from "./DraftReceiptTurn";

function DraftRejectTurnComponent({ turn }: { turn: Turn }) {
  return <DraftReceiptTurn turn={turn} kind="reject" />;
}

export const DraftRejectTurn = memo(
  DraftRejectTurnComponent,
  (prev, next) => prev.turn === next.turn,
);
DraftRejectTurn.displayName = "DraftRejectTurn";
