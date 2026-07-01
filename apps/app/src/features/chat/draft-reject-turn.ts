/** Helpers for recognizing user turns that record rejecting an AI draft. */
import { isDraftRejectTurnRequestParams } from "@meridian/contracts/drafts";
import type { Turn } from "@meridian/contracts/protocol";

export function isDraftRejectTurn(turn: Turn): boolean {
  return turn.role === "user" && isDraftRejectTurnRequestParams(turn.requestParams);
}
