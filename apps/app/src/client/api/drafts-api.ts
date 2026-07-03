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
  DraftJournalResponse,
  DraftPreviewResponse,
  DraftRejectRequest,
  DraftRejectResponse,
  DraftUndoResponse,
  ThreadDraftListResponse,
} from "@meridian/contracts/drafts";
import {
  apiProjectWorkDocumentDraftAcceptPath,
  apiProjectWorkDocumentDraftJournalPath,
  apiProjectWorkDocumentDraftPath,
  apiProjectWorkDocumentDraftRejectPath,
  apiProjectWorkDocumentDraftUndoAcceptPath,
  apiProjectWorkDocumentDraftUndoRejectPath,
  apiProjectWorkDraftsPath,
} from "@meridian/contracts/protocol";

import { errorMessageFromPayload, getJson, postJson, readResponsePayload } from "./http-client";

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
  options?: { surface?: "inline" },
): Promise<DraftPreviewResponse> {
  const params = new URLSearchParams({ draftId });
  if (options?.surface) params.set("surface", options.surface);
  return getJson<DraftPreviewResponse>(
    `${apiProjectWorkDocumentDraftPath(projectId, workId, documentId)}?${params}`,
  );
}

export class StaleDraftJournalError extends Error {
  constructor() {
    super("Draft revision is stale");
    this.name = "StaleDraftJournalError";
  }
}

export async function getDraftJournal(
  projectId: string,
  workId: string,
  documentId: string,
  draftId: string,
  revisionToken: number,
): Promise<DraftJournalResponse> {
  const params = new URLSearchParams({ draftId, revisionToken: String(revisionToken) });
  const response = await fetch(
    `${apiProjectWorkDocumentDraftJournalPath(projectId, workId, documentId)}?${params}`,
  );
  const payload = await readResponsePayload(response);
  if (response.status === 409 && isStaleRevisionPayload(payload))
    throw new StaleDraftJournalError();
  if (!response.ok) throw new Error(errorMessageFromPayload(payload, response.status));
  return payload as DraftJournalResponse;
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

export async function undoAcceptDraft(
  projectId: string,
  workId: string,
  documentId: string,
  body: { draftId: string; writeId?: string },
): Promise<DraftUndoResponse> {
  return postJson<DraftUndoResponse>(
    apiProjectWorkDocumentDraftUndoAcceptPath(projectId, workId, documentId),
    body,
  );
}

export async function undoRejectDraft(
  projectId: string,
  workId: string,
  documentId: string,
  body: { draftId: string; writeId?: string },
): Promise<DraftUndoResponse> {
  return postJson<DraftUndoResponse>(
    apiProjectWorkDocumentDraftUndoRejectPath(projectId, workId, documentId),
    body,
  );
}

function isStaleRevisionPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as { data?: unknown };
  if (record.data && typeof record.data === "object") {
    return (record.data as { code?: unknown }).code === "stale_revision";
  }
  return (payload as { code?: unknown }).code === "stale_revision";
}
