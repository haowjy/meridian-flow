/**
 * drafts-api — HTTP client for the AI draft review endpoints.
 *
 * The review itself is computed in the browser from the item's room, so the wire carries the Work's item
 * rows, where to open one item (`DraftItemMeta`), Apply's commands and the close-only Discard commands.
 * Bodies and results are the contract's strict schemas and types (re-landing contract §1).
 */
import type {
  DocumentDraftHintsResponse,
  DraftApplyAllBody,
  DraftApplyAllResult,
  DraftApplyChangesBody,
  DraftApplyItemBody,
  DraftApplyPendingResponse,
  DraftAttribution,
  DraftCommandObservation,
  DraftDiscardAllBody,
  DraftDiscardAllResponse,
  DraftItemApplyResult,
  DraftItemDiscardBody,
  DraftItemDiscardResult,
  DraftItemMeta,
  ThreadDraftFilesResponse,
  ThreadDraftListResponse,
} from "@meridian/contracts/drafts";
import {
  apiProjectDocumentDraftsPath,
  apiProjectWorkDocumentDraftApplyChangesPath,
  apiProjectWorkDocumentDraftApplyPath,
  apiProjectWorkDocumentDraftAttributionPath,
  apiProjectWorkDocumentDraftDiscardPath,
  apiProjectWorkDocumentDraftPath,
  apiProjectWorkDraftCommandPath,
  apiProjectWorkDraftsApplyPath,
  apiProjectWorkDraftsDiscardPath,
  apiProjectWorkDraftsPath,
  apiThreadDraftFilesPath,
} from "@meridian/contracts/protocol";

import { getJson, httpErrorStatus, postJson } from "./http-client";

export async function listWorkDrafts(
  projectId: string,
  workId: string,
): Promise<ThreadDraftListResponse> {
  return getJson<ThreadDraftListResponse>(apiProjectWorkDraftsPath(projectId, workId));
}

export function listDocumentDraftHints(
  projectId: string,
  documentId: string,
): Promise<DocumentDraftHintsResponse> {
  return getJson<DocumentDraftHintsResponse>(apiProjectDocumentDraftsPath(projectId, documentId));
}

/** Where to open one item. A 404 means the item is closed (`gone`); the caller maps it. */
export async function getDraftMeta(
  projectId: string,
  workId: string,
  documentId: string,
  itemKey: string,
  signal?: AbortSignal,
): Promise<DraftItemMeta> {
  const params = new URLSearchParams({ itemKey });
  return getJson<DraftItemMeta>(
    `${apiProjectWorkDocumentDraftPath(projectId, workId, documentId)}?${params}`,
    { signal },
  );
}

/**
 * A command's refusal that is a recognized outcome, not an error: the server answers it 409 (or 404
 * `gone`) with a body naming the outcome (`stale`, `held`, ...). An error without one
 * (`command_conflict`) stays an error.
 */
function acceptOutcomeBody(status: number, payload: unknown): boolean {
  return (
    (status === 409 || status === 404) &&
    typeof payload === "object" &&
    payload !== null &&
    "status" in payload &&
    typeof payload.status === "string"
  );
}
const outcomeOptions = { acceptErrorResponse: acceptOutcomeBody };

function identifies(response: { itemKey?: string }, itemKey: string): void {
  if (response.itemKey !== itemKey)
    throw new Error("Draft command response did not identify the requested item");
}

/** Apply some changes of one item: 200 applied, 202 pending (observe the command), or a refusal body. */
export async function applyDraftChanges(
  projectId: string,
  workId: string,
  documentId: string,
  request: DraftApplyChangesBody,
): Promise<DraftItemApplyResult | DraftApplyPendingResponse> {
  const response = await postJson<DraftItemApplyResult | DraftApplyPendingResponse>(
    apiProjectWorkDocumentDraftApplyChangesPath(projectId, workId, documentId),
    request,
    outcomeOptions,
  );
  if (response.status !== "pending") identifies(response, request.itemKey);
  return response;
}

/** Apply one whole item (open review, Work row, or a whole-item item's single change). */
export async function applyDraft(
  projectId: string,
  workId: string,
  documentId: string,
  request: DraftApplyItemBody,
): Promise<DraftItemApplyResult | DraftApplyPendingResponse> {
  const response = await postJson<DraftItemApplyResult | DraftApplyPendingResponse>(
    apiProjectWorkDocumentDraftApplyPath(projectId, workId, documentId),
    request,
    outcomeOptions,
  );
  if (response.status !== "pending") identifies(response, request.itemKey);
  return response;
}

/** Item Discard (a created, binary or live-deleted item): close-only, completes in its own transaction. */
export async function discardDraft(
  projectId: string,
  workId: string,
  documentId: string,
  request: DraftItemDiscardBody,
): Promise<DraftItemDiscardResult> {
  const response = await postJson<DraftItemDiscardResult>(
    apiProjectWorkDocumentDraftDiscardPath(projectId, workId, documentId),
    request,
    outcomeOptions,
  );
  identifies(response, request.itemKey);
  return response;
}

/** Work Files' "Apply all changes": one server command over the listed items. */
export async function applyAllDrafts(
  projectId: string,
  workId: string,
  request: DraftApplyAllBody,
): Promise<DraftApplyAllResult | DraftApplyPendingResponse> {
  return postJson<DraftApplyAllResult | DraftApplyPendingResponse>(
    apiProjectWorkDraftsApplyPath(projectId, workId),
    request,
    outcomeOptions,
  );
}

/** Work Files' "Discard all changes": one `discard_draft` command that closes the Work's draft. */
export async function discardAllDrafts(
  projectId: string,
  workId: string,
  request: DraftDiscardAllBody,
): Promise<DraftDiscardAllResponse> {
  return postJson<DraftDiscardAllResponse>(
    apiProjectWorkDraftsDiscardPath(projectId, workId),
    request,
    outcomeOptions,
  );
}

/**
 * What the server recorded for a command. A 404 means nothing committed under the id (the contract's
 * `unknown_command`), which the caller answers by resending the same command.
 */
export async function observeDraftCommand(
  projectId: string,
  workId: string,
  commandId: string,
): Promise<DraftCommandObservation | { state: "unknown" }> {
  try {
    return await getJson<DraftCommandObservation>(
      apiProjectWorkDraftCommandPath(projectId, workId, commandId),
    );
  } catch (error) {
    if (httpErrorStatus(error) === 404) return { state: "unknown" };
    throw error;
  }
}

/** The AI edit parts pending in an item: the ranges the browser matches to a change to name its chats. */
export async function getDraftAttribution(
  projectId: string,
  workId: string,
  documentId: string,
  itemKey: string,
  signal?: AbortSignal,
): Promise<DraftAttribution> {
  const params = new URLSearchParams({ itemKey });
  return getJson<DraftAttribution>(
    `${apiProjectWorkDocumentDraftAttributionPath(projectId, workId, documentId)}?${params}`,
    { signal },
  );
}

/** The chat strip's collapsed list: items with changes this chat has pending AI edits in. */
export async function getThreadDraftFiles(threadId: string): Promise<ThreadDraftFilesResponse> {
  return getJson<ThreadDraftFilesResponse>(apiThreadDraftFilesPath(threadId));
}
