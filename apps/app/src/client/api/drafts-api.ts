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
  DraftUndoResponse,
  ThreadDraftListResponse,
} from "@meridian/contracts/drafts";
import {
  apiThreadDocumentDraftAcceptPath,
  apiThreadDocumentDraftPath,
  apiThreadDocumentDraftRejectPath,
  apiThreadDocumentDraftUndoAcceptPath,
  apiThreadDocumentDraftUndoRejectPath,
  apiThreadDraftsPath,
} from "@meridian/contracts/protocol";

import { getJson, postJson } from "./http-client";

export async function listThreadDrafts(threadId: string): Promise<ThreadDraftListResponse> {
  return getJson<ThreadDraftListResponse>(apiThreadDraftsPath(threadId));
}

export async function getDraftPreview(
  threadId: string,
  documentId: string,
  draftId: string,
): Promise<DraftPreviewResponse> {
  const params = new URLSearchParams({ draftId });
  return getJson<DraftPreviewResponse>(
    `${apiThreadDocumentDraftPath(threadId, documentId)}?${params}`,
  );
}

export async function acceptDraft(
  threadId: string,
  documentId: string,
  request: DraftAcceptRequest,
): Promise<DraftAcceptResponse> {
  return postJson<DraftAcceptResponse>(
    apiThreadDocumentDraftAcceptPath(threadId, documentId),
    request,
  );
}

export async function rejectDraft(
  threadId: string,
  documentId: string,
  request: DraftRejectRequest,
): Promise<DraftRejectResponse> {
  return postJson<DraftRejectResponse>(
    apiThreadDocumentDraftRejectPath(threadId, documentId),
    request,
  );
}

export async function undoAcceptDraft(
  threadId: string,
  documentId: string,
  body: { draftId: string },
): Promise<DraftUndoResponse> {
  return postJson<DraftUndoResponse>(
    apiThreadDocumentDraftUndoAcceptPath(threadId, documentId),
    body,
  );
}

export async function undoRejectDraft(
  threadId: string,
  documentId: string,
  body: { draftId: string },
): Promise<DraftUndoResponse> {
  return postJson<DraftUndoResponse>(
    apiThreadDocumentDraftUndoRejectPath(threadId, documentId),
    body,
  );
}
