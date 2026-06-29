/** live-lineage-api — HTTP client for server-owned turn live-lineage reads. */
import type { ListTurnLiveLineageResponse } from "@meridian/contracts/protocol";
import { apiThreadTurnLiveLineagePath } from "@meridian/contracts/protocol";

import { getJson } from "./http-client";

export async function listTurnLiveLineage(
  threadId: string,
  turnId: string,
): Promise<ListTurnLiveLineageResponse> {
  return getJson<ListTurnLiveLineageResponse>(apiThreadTurnLiveLineagePath(threadId, turnId));
}
