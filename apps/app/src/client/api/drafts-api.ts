/**
 * drafts-api — HTTP client for AI document draft review endpoints.
 *
 * Typed wrappers for listing active thread drafts, reading live-vs-draft
 * markdown previews, and accepting/rejecting a draft without exposing route
 * strings to query hooks.
 */
import type {
  DraftAcceptResponse,
  DraftPreviewResponse,
  DraftRejectResponse,
  ThreadDraftListResponse,
} from "@meridian/contracts/drafts";
import {
  apiThreadDocumentDraftAcceptPath,
  apiThreadDocumentDraftPath,
  apiThreadDocumentDraftRejectPath,
  apiThreadDraftsPath,
} from "@meridian/contracts/protocol";

import { getJson, postJson } from "./http-client";

export async function listThreadDrafts(threadId: string): Promise<ThreadDraftListResponse> {
  return getJson<ThreadDraftListResponse>(apiThreadDraftsPath(threadId));
}

export async function getDraftPreview(
  threadId: string,
  documentId: string,
): Promise<DraftPreviewResponse> {
  return getJson<DraftPreviewResponse>(apiThreadDocumentDraftPath(threadId, documentId));
}

export async function acceptDraft(
  threadId: string,
  documentId: string,
): Promise<DraftAcceptResponse> {
  return postJson<DraftAcceptResponse>(apiThreadDocumentDraftAcceptPath(threadId, documentId), {});
}

export async function rejectDraft(
  threadId: string,
  documentId: string,
): Promise<DraftRejectResponse> {
  return postJson<DraftRejectResponse>(apiThreadDocumentDraftRejectPath(threadId, documentId), {});
}
