/** restore-delete-api — the writer restores a document the agent deleted in a turn. */
import {
  apiThreadTurnRestoreDeletePath,
  type RestoreAgentDeleteResponse,
} from "@meridian/contracts/protocol";

import { httpErrorStatus, postJson } from "./http-client";

/** What a restore came to. `already_restored` is the route's 404: no delete of that document is still applied in that turn. */
export type RestoreDeleteOutcome = RestoreAgentDeleteResponse["status"] | "already_restored";

export async function restoreAgentDelete(
  threadId: string,
  input: { turnId: string; documentId: string },
): Promise<RestoreDeleteOutcome> {
  try {
    const response = await postJson<RestoreAgentDeleteResponse>(
      apiThreadTurnRestoreDeletePath(threadId, input.turnId),
      { documentId: input.documentId },
      // The two refusals answer 409 with the same typed body as success.
      { acceptErrorResponse: (status) => status === 409 },
    );
    return response.status;
  } catch (error) {
    if (httpErrorStatus(error) === 404) return "already_restored";
    throw error;
  }
}
