/** restore-delete-api — the writer restores a document the agent deleted in a turn. */
import {
  apiThreadTurnRestoreDeletePath,
  type RestoreAgentDeleteResponse,
} from "@meridian/contracts/protocol";

import { postJson } from "./http-client";

/** What a restore came to, as the route answers it. */
export type RestoreDeleteOutcome = RestoreAgentDeleteResponse["status"];

const REFUSALS: ReadonlySet<unknown> = new Set<RestoreDeleteOutcome>([
  "location_taken",
  "folder_missing",
  "nothing_to_restore",
]);

export async function restoreAgentDelete(
  threadId: string,
  input: { turnId: string; documentId: string },
): Promise<RestoreDeleteOutcome> {
  const response = await postJson<RestoreAgentDeleteResponse>(
    apiThreadTurnRestoreDeletePath(threadId, input.turnId),
    { documentId: input.documentId },
    // The route's refusals answer 409 with a typed body. Any other 409 (a
    // context conflict passed through) or 404 is a failed request.
    {
      acceptErrorResponse: (status, payload) =>
        status === 409 && REFUSALS.has((payload as { status?: unknown } | null)?.status),
    },
  );
  return response.status;
}
