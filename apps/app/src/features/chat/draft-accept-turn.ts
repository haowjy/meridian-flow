/** Helpers for recognizing user turns that record accepting an AI draft. */
import { isDraftAcceptTurnRequestParams } from "@meridian/contracts/drafts";
import type { Turn } from "@meridian/contracts/protocol";

export function isDraftAcceptTurn(turn: Turn): boolean {
  return turn.role === "user" && isDraftAcceptTurnRequestParams(turn.requestParams);
}
