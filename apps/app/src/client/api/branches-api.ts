/**
 * branches-api — HTTP client for AI document draft review endpoints.
 *
 * Typed wrappers for listing active thread branches, reading live-vs-draft
 * markdown previews, and applying/discarding a draft without exposing route
 * strings to query hooks.
 */
import type {
  BranchApplyAllRequest,
  BranchApplyAllResponse,
  BranchCommandObservation,
  BranchDiscardAllRequest,
  BranchDiscardAllResponse,
  DocumentDraftHintsResponse,
  DraftApplyChangesRequest,
  DraftApplyChangesResponse,
  DraftApplyHttpResponse,
  DraftApplyRefusalBody,
  DraftApplyRequest,
  DraftDiscardRequest,
  DraftDiscardResponse,
  DraftPreviewResponse,
  ThreadDraftListResponse,
} from "@meridian/contracts/branches";
import {
  apiProjectDocumentBranchesPath,
  apiProjectWorkBranchCommandPath,
  apiProjectWorkBranchesApplyPath,
  apiProjectWorkBranchesDiscardPath,
  apiProjectWorkBranchesPath,
  apiProjectWorkDocumentDraftApplyChangesPath,
  apiProjectWorkDocumentDraftApplyPath,
  apiProjectWorkDocumentDraftDiscardPath,
  apiProjectWorkDocumentDraftPath,
} from "@meridian/contracts/protocol";

import { getJson, httpErrorStatus, postJson } from "./http-client";

export async function listWorkBranches(
  projectId: string,
  workId: string,
): Promise<ThreadDraftListResponse> {
  return getJson<ThreadDraftListResponse>(apiProjectWorkBranchesPath(projectId, workId));
}

export function listDocumentDraftHints(
  projectId: string,
  documentId: string,
): Promise<DocumentDraftHintsResponse> {
  return getJson<DocumentDraftHintsResponse>(apiProjectDocumentBranchesPath(projectId, documentId));
}

export async function getDraftPreview(
  projectId: string,
  workId: string,
  documentId: string,
  itemKey: string,
  signal?: AbortSignal,
): Promise<DraftPreviewResponse> {
  const params = new URLSearchParams({ itemKey });
  const preview = await getJson<DraftPreviewResponse>(
    `${apiProjectWorkDocumentDraftPath(projectId, workId, documentId)}?${params}`,
    { signal },
  );
  if (preview.status === "active" && !preview.reviewRoomName) {
    throw new Error("Branch preview response is missing reviewRoomName");
  }
  if (preview.status === "active" && typeof preview.draftGeneration !== "number") {
    throw new Error("Branch preview response is missing draftGeneration");
  }
  return preview;
}

/**
 * A command's refusal that is a recognized outcome, not an error: the server answers it 409 with a
 * body naming the outcome (`stale`, `held`, ...). A 409 without one (`command_conflict`) stays an error.
 */
function acceptOutcomeBody(status: number, payload: unknown): boolean {
  return (
    status === 409 &&
    typeof payload === "object" &&
    payload !== null &&
    "status" in payload &&
    typeof payload.status === "string"
  );
}
const outcomeOptions = { acceptErrorResponse: acceptOutcomeBody };

/** Item Apply: 200 applied, 202 pending (observe the command), or a held or stale refusal body. */
export async function applyDraft(
  projectId: string,
  workId: string,
  documentId: string,
  request: DraftApplyRequest,
): Promise<DraftApplyHttpResponse | DraftApplyRefusalBody> {
  const response = await postJson<DraftApplyHttpResponse | DraftApplyRefusalBody>(
    apiProjectWorkDocumentDraftApplyPath(projectId, workId, documentId),
    request,
    outcomeOptions,
  );
  if (
    (response.status === "applied" || response.status === "held" || response.status === "stale") &&
    response.itemKey !== request.itemKey
  )
    throw new Error("Branch Apply response did not identify the requested item");
  return response;
}

export async function applyDraftChanges(
  projectId: string,
  workId: string,
  documentId: string,
  request: DraftApplyChangesRequest,
): Promise<DraftApplyChangesResponse> {
  const response = await postJson<DraftApplyChangesResponse>(
    apiProjectWorkDocumentDraftApplyChangesPath(projectId, workId, documentId),
    request,
    outcomeOptions,
  );
  if (response.status === "pending") return response;
  if (
    response.itemKey !== request.itemKey ||
    !["applied", "stale", "gone", "whole_item", "incomplete_class"].includes(response.status)
  )
    throw new Error("Branch change Apply response did not identify the requested item");
  if (
    response.status === "applied" &&
    (!Array.isArray(response.operationIds) ||
      response.operationIds.length !== new Set(request.operationIds).size ||
      request.operationIds.some((id) => !response.operationIds.includes(id)) ||
      !Array.isArray(response.closureClassIds) ||
      response.closureClassIds.length === 0)
  )
    throw new Error(
      "Branch change Apply response did not prove the requested changes were applied",
    );
  return response;
}

/** Item or per-change Discard; completes in its own transaction, so it is never pending. */
export async function discardDraft(
  projectId: string,
  workId: string,
  documentId: string,
  request: DraftDiscardRequest,
): Promise<DraftDiscardResponse> {
  return postJson<DraftDiscardResponse>(
    apiProjectWorkDocumentDraftDiscardPath(projectId, workId, documentId),
    request,
    outcomeOptions,
  );
}

/** Work Files' "Apply all changes": one server command over the listed items. */
export async function applyAllBranches(
  projectId: string,
  workId: string,
  request: BranchApplyAllRequest,
): Promise<BranchApplyAllResponse> {
  return postJson<BranchApplyAllResponse>(
    apiProjectWorkBranchesApplyPath(projectId, workId),
    request,
    outcomeOptions,
  );
}

/** Work Files' "Discard all changes": one server command that closes the Work's draft. */
export async function discardAllBranches(
  projectId: string,
  workId: string,
  request: BranchDiscardAllRequest,
): Promise<BranchDiscardAllResponse> {
  return postJson<BranchDiscardAllResponse>(
    apiProjectWorkBranchesDiscardPath(projectId, workId),
    request,
    outcomeOptions,
  );
}

/**
 * What the server recorded for a command. A 404 means nothing committed under the id (the contract's
 * `unknown_command`), which the caller answers by resending the same command.
 */
export async function observeBranchCommand(
  projectId: string,
  workId: string,
  commandId: string,
): Promise<BranchCommandObservation | { state: "unknown" }> {
  try {
    return await getJson<BranchCommandObservation>(
      apiProjectWorkBranchCommandPath(projectId, workId, commandId),
    );
  } catch (error) {
    if (httpErrorStatus(error) === 404) return { state: "unknown" };
    throw error;
  }
}
