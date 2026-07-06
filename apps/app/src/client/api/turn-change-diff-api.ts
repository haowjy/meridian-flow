/** turn-change-diff-api — HTTP client for receipt-chip View-change diffs. */
import type { TurnChangeDiffResponse } from "@meridian/contracts/protocol";
import { apiThreadTurnChangeDiffPath } from "@meridian/contracts/protocol";

import { getJson } from "./http-client";

export function getTurnChangeDiff(
  threadId: string,
  turnId: string,
): Promise<TurnChangeDiffResponse> {
  return getJson<TurnChangeDiffResponse>(apiThreadTurnChangeDiffPath(threadId, turnId));
}
