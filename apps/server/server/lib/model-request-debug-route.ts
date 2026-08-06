/**
 * Route core for GET /api/threads/:threadId/debug/model-requests — owner-gated
 * read of dev-only orchestrator model-request capture.
 */
import type { ModelRequestDebugListResponse } from "@meridian/contracts/protocol";
import type { ModelRequestDebugRecord } from "@meridian/contracts/threads";
import { createError } from "nitro/h3";
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

export type ModelRequestDebugQueryParameters = Record<string, string | string[] | undefined>;

function badQuery(message: string): never {
  throw createError({ statusCode: 400, message });
}

function singleQueryValue(
  query: ModelRequestDebugQueryParameters,
  key: string,
): string | undefined {
  const value = query[key];
  if (Array.isArray(value)) badQuery(`${key} must be supplied once`);
  if (value === "") badQuery(`${key} must not be empty`);
  return value;
}

/** Parse narrowing selectors strictly so malformed protected-content queries fail closed. */
export function parseModelRequestDebugQuery(query: ModelRequestDebugQueryParameters): {
  turnId?: string;
  gatewayCallId?: string;
  iteration?: number;
  latest?: boolean;
} {
  const turnId = singleQueryValue(query, "turnId");
  const gatewayCallId = singleQueryValue(query, "gatewayCallId");
  const rawIteration = singleQueryValue(query, "iteration");
  const rawLatest = singleQueryValue(query, "latest");

  let iteration: number | undefined;
  if (rawIteration !== undefined) {
    iteration = Number(rawIteration);
    if (!Number.isSafeInteger(iteration) || iteration < 0) {
      badQuery("iteration must be a non-negative integer");
    }
  }

  let latest: boolean | undefined;
  if (rawLatest !== undefined) {
    if (rawLatest === "1" || rawLatest === "true") latest = true;
    else if (rawLatest === "0" || rawLatest === "false") latest = false;
    else badQuery("latest must be true, false, 1, or 0");
  }

  return { turnId, gatewayCallId, iteration, latest };
}

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
