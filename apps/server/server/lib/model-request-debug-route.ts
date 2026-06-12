/**
 * Route core for GET /api/threads/:threadId/debug/model-requests — owner-gated
 * read of dev-only orchestrator model-request capture.
 */
import type { ModelRequestDebugListResponse } from "@meridian/contracts/protocol";
import type { ModelRequestDebugRecord } from "@meridian/contracts/threads";
import type { ModelRequestDebugStore } from "../domains/runtime/model-request-debug/index.js";
import { requireThreadOwner } from "../domains/threads/index.js";
import type { ThreadRepositories } from "./compose.js";
import { throwHttpInterruptForStatus } from "./interrupt-boundary.js";

export interface ModelRequestDebugRouteDeps {
  repos: Pick<ThreadRepositories, "threads">;
  workbenchRepo: Parameters<typeof requireThreadOwner>[0]["workbenches"];
  modelRequestDebug: ModelRequestDebugStore;
}

export async function handleGetModelRequestDebugRecords(
  deps: ModelRequestDebugRouteDeps,
  input: { threadId: string; userId: string; turnId?: string },
): Promise<ModelRequestDebugListResponse> {
  if (!deps.modelRequestDebug.captureEnabled) {
    throwHttpInterruptForStatus(404, "Thread not found");
  }

  await requireThreadOwner(
    { threads: deps.repos.threads, workbenches: deps.workbenchRepo },
    input.threadId,
    input.userId,
  );

  const records: ModelRequestDebugRecord[] = input.turnId
    ? deps.modelRequestDebug.listByTurn(input.threadId, input.turnId)
    : deps.modelRequestDebug.listByThread(input.threadId);

  return { records };
}
