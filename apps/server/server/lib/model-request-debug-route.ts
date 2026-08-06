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
  projectRepo: Parameters<typeof requireThreadOwner>[0]["projects"];
  modelRequestDebug: ModelRequestDebugStore;
}

type ModelRequestDebugSelection = {
  gatewayCallId?: string;
  iteration?: number;
  latest?: boolean;
};

/** Narrow exported records while retaining only the adjacent prefix context. */
export function selectModelRequestDebugRecords(
  available: readonly ModelRequestDebugRecord[],
  selection: ModelRequestDebugSelection,
): ModelRequestDebugRecord[] {
  const narrowed = available.filter(
    (record) =>
      (selection.gatewayCallId === undefined || record.gatewayCallId === selection.gatewayCallId) &&
      (selection.iteration === undefined || record.iteration === selection.iteration),
  );
  const selected = selection.latest ? narrowed.slice(-1) : narrowed;
  const needsProjectionContext =
    selection.latest === true ||
    selection.gatewayCallId !== undefined ||
    selection.iteration !== undefined;
  if (!needsProjectionContext) return selected;

  const selectedIds = new Set(selected.map((record) => record.gatewayCallId));
  for (const record of selected) {
    const previous = available.find(
      (candidate) =>
        candidate.turnId === record.turnId && candidate.iteration === record.iteration - 1,
    );
    if (previous) selectedIds.add(previous.gatewayCallId);
  }
  return available.filter((record) => selectedIds.has(record.gatewayCallId));
}

export async function handleGetModelRequestDebugRecords(
  deps: ModelRequestDebugRouteDeps,
  input: {
    threadId: string;
    userId: string;
    turnId?: string;
    gatewayCallId?: string;
    iteration?: number;
    latest?: boolean;
  },
): Promise<ModelRequestDebugListResponse> {
  if (!deps.modelRequestDebug.captureEnabled) {
    throwHttpInterruptForStatus(404, "Thread not found");
  }

  const thread = await requireThreadOwner(
    { threads: deps.repos.threads, projects: deps.projectRepo },
    input.threadId,
    input.userId,
  );

  const available: ModelRequestDebugRecord[] = input.turnId
    ? deps.modelRequestDebug.listByTurn(thread.id, input.turnId)
    : deps.modelRequestDebug.listByThread(thread.id);
  const records = selectModelRequestDebugRecords(available, input);

  return { records, retention: deps.modelRequestDebug.retention() };
}
