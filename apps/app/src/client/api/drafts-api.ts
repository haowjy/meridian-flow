/**
 * drafts-api — HTTP client for AI document draft review endpoints.
 *
 * Typed wrappers for listing active thread drafts, reading live-vs-draft
 * markdown previews, and accepting/rejecting a draft without exposing route
 * strings to query hooks.
 */
import type {
  DraftAcceptRequest,
  DraftAcceptResponse,
  DraftPreviewResponse,
  DraftRejectRequest,
  DraftRejectResponse,
  ThreadDraftListResponse,
} from "@meridian/contracts/drafts";
import {
  apiProjectWorkDocumentDraftAcceptPath,
  apiProjectWorkDocumentDraftPath,
  apiProjectWorkDocumentDraftRejectPath,
  apiProjectWorkDraftsPath,
} from "@meridian/contracts/protocol";

import { getJson, postJson } from "./http-client";

export async function listWorkDrafts(
  projectId: string,
  workId: string,
): Promise<ThreadDraftListResponse> {
  return getJson<ThreadDraftListResponse>(apiProjectWorkDraftsPath(projectId, workId));
}

export async function getDraftPreview(
  projectId: string,
  workId: string,
  documentId: string,
  draftId: string,
): Promise<DraftPreviewResponse> {
  const params = new URLSearchParams({ draftId });
  return getJson<DraftPreviewResponse>(
    `${apiProjectWorkDocumentDraftPath(projectId, workId, documentId)}?${params}`,
  );
}

export async function acceptDraft(
  projectId: string,
  workId: string,
  documentId: string,
  request: DraftAcceptRequest,
): Promise<DraftAcceptResponse> {
  return postJson<DraftAcceptResponse>(
    apiProjectWorkDocumentDraftAcceptPath(projectId, workId, documentId),
    request,
  );
}

export async function rejectDraft(
  projectId: string,
  workId: string,
  documentId: string,
  request: DraftRejectRequest,
): Promise<DraftRejectResponse> {
  return postJson<DraftRejectResponse>(
    apiProjectWorkDocumentDraftRejectPath(projectId, workId, documentId),
    request,
  );
}
