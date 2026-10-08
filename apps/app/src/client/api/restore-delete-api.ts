/** restore-delete-api — the writer restores a document the agent deleted in a turn. */
import {
  apiThreadTurnRestoreDeletePath,
  type RestoreAgentDeleteResponse,
} from "@meridian/contracts/protocol";

import { postJson } from "./http-client";

/** What a restore came to, as the route answers it. */
export type RestoreDeleteOutcome = RestoreAgentDeleteResponse;

const REFUSALS: ReadonlySet<unknown> = new Set<RestoreDeleteOutcome["status"]>([
  "location_taken",
  "folder_missing",
  "nothing_to_restore",
  "permission_denied",
]);

export async function restoreAgentDelete(
  threadId: string,
  input: { turnId: string; documentId: string },
): Promise<RestoreDeleteOutcome> {
  const response = await postJson<RestoreAgentDeleteResponse>(
    apiThreadTurnRestoreDeletePath(threadId, input.turnId),
    { documentId: input.documentId },
    // Expected refusals preserve their typed body; unknown HTTP failures stay request errors.
    {
      acceptErrorResponse: (status, payload) =>
        (status === 409 || status === 403) &&
        REFUSALS.has((payload as { status?: unknown } | null)?.status),
    },
  );
  return response;
}
