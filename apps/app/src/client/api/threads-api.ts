/**
 * threads-api — HTTP client for thread lifecycle and snapshot endpoints.
 *
 * Typed wrappers for list/create thread, append user message, cancel turn,
 * delete thread, and fetch/deserialize a thread snapshot. Owns the thread
 * network surface the chat flow and snapshot sync build on.
 */
import {
  API_THREADS_PATH,
  apiThreadCancelPath,
  apiThreadMessagePath,
  apiThreadModelRequestsDebugPath,
  apiThreadOpenedPath,
  apiThreadPath,
  apiThreadRecentDocumentsPath,
  apiThreadSnapshotPath,
  apiThreadTurnContextPreviewDebugPath,
  apiThreadUploadsPath,
  type CancelTurnResponse,
  type ListThreadRecentDocumentsResponse,
  type ListThreadsResponse,
  type ListThreadUploadsResponse,
  type ModelRequestDebugListResponse,
  type SendMessageResponse,
  type Thread,
  type ThreadRecentDocumentItem,
  type ThreadSnapshotResponse,
  type ThreadUploadDocumentItem,
  type TurnContextPreview,
} from "@meridian/contracts/protocol";

import { deleteRequest, getJson, postJson } from "./http-client";

type CreateThreadInput = {
  id?: string;
  projectId: string;
  title?: string;
  systemPrompt?: string | null;
  currentAgent?: string;
};

export type AppendUserMessageInput = {
  threadId: string;
  text: string;
  connectionToken?: string;
};

type CancelTurnInput = {
  threadId: string;
  turnId: string;
  reason?: string;
};

type GetThreadSnapshotInput = {
  threadId: string;
  after?: string;
};

export async function listThreads(init?: {
  origin?: string;
  headers?: HeadersInit;
}): Promise<Thread[]> {
  const url = init?.origin ? new URL(API_THREADS_PATH, init.origin).toString() : API_THREADS_PATH;
  const response = await getJson<ListThreadsResponse>(url, { headers: init?.headers });
  // Server returns domain types; JSON serialization strips brands + converts Dates to strings,
  // yielding the Wire shape the frontend operates on.
  return response.threads as unknown as Thread[];
}

export function createThread({ data }: { data: CreateThreadInput }): Promise<Thread> {
  return postJson(API_THREADS_PATH, data) as unknown as Promise<Thread>;
}

export function appendUserMessage({
  data,
}: {
  data: AppendUserMessageInput;
}): Promise<SendMessageResponse> {
  return postJson(apiThreadMessagePath(data.threadId), data);
}

export function cancelTurn({ data }: { data: CancelTurnInput }): Promise<CancelTurnResponse> {
  return postJson(apiThreadCancelPath(data.threadId, data.turnId), {
    reason: data.reason,
  });
}

export function deleteThread({ data }: { data: { threadId: string } }): Promise<void> {
  return deleteRequest(apiThreadPath(data.threadId));
}

export function getThreadSnapshot({
  data,
}: {
  data: GetThreadSnapshotInput;
}): Promise<ThreadSnapshotResponse> {
  return getJson(apiThreadSnapshotPath(data.threadId, { after: data.after }));
}

export function markThreadOpened(
  threadId: string,
): Promise<{ threadId: string; openedAt: string }> {
  return postJson(apiThreadOpenedPath(threadId), {});
}

/**
 * `getThreadSnapshot` runs through {@link deserializeTransport} (Dates, bigint).
 * Normalize to the wire JSON shape the store and UI expect (ISO date strings, plain ids).
 */
export function deserializeThreadSnapshot(
  response: ThreadSnapshotResponse,
): ThreadSnapshotResponse {
  return JSON.parse(
    JSON.stringify(response, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  ) as ThreadSnapshotResponse;
}

/** Canonical projection from the wire snapshot to the store apply boundary. */
export function toThreadSnapshotApplyOptions(snapshot: ThreadSnapshotResponse) {
  return {
    lifecycle: {
      attention: snapshot.attention,
      runningTurnId: snapshot.liveState.runningTurnId,
    },
    nextSeq: snapshot.nextSeq,
  };
}

/**
 * GET /api/threads/:threadId/uploads — files the user uploaded into this
 * thread (`thread_documents` rows where the relationship is an upload).
 */
export async function getThreadUploads(threadId: string): Promise<ThreadUploadDocumentItem[]> {
  const response = await getJson<ListThreadUploadsResponse>(apiThreadUploadsPath(threadId));
  return response.uploads;
}

/**
 * GET /api/threads/:threadId/recent-documents — documents the agent recently
 * read/touched in this thread (`turn_document_touches`, deduped by docId).
 */
export async function getThreadRecentDocuments(
  threadId: string,
  opts?: { limit?: number },
): Promise<ThreadRecentDocumentItem[]> {
  const response = await getJson<ListThreadRecentDocumentsResponse>(
    apiThreadRecentDocumentsPath(threadId, opts),
  );
  return response.documents;
}

/** GET /api/threads/:threadId/debug/model-requests — dev-only orchestrator capture. */
export function getThreadModelRequestDebugRecords({
  data,
}: {
  data: { threadId: string; turnId?: string };
}): Promise<ModelRequestDebugListResponse> {
  return getJson<ModelRequestDebugListResponse>(
    apiThreadModelRequestsDebugPath(data.threadId, { turnId: data.turnId }),
  );
}

/** GET /api/threads/:threadId/debug/turn-context-preview — dev-only next-turn model context. */
export function getThreadTurnContextPreview({
  data,
}: {
  data: { threadId: string };
}): Promise<TurnContextPreview> {
  return getJson<TurnContextPreview>(apiThreadTurnContextPreviewDebugPath(data.threadId));
}
