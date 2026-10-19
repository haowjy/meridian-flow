/** HTTP client for draft-review read endpoints. */
import type {
  DocumentDraftHintsResponse,
  DraftPreviewResponse,
  ThreadDraftListResponse,
} from "@meridian/contracts/branches";
import {
  apiProjectDocumentBranchesPath,
  apiProjectWorkBranchesPath,
} from "@meridian/contracts/protocol";

import { getJson } from "./http-client";

export async function listWorkBranchDrafts(
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
  _projectId: string,
  _workId: string,
  _documentId: string,
  itemKey: string,
  _signal?: AbortSignal,
): Promise<DraftPreviewResponse> {
  return { status: "gone", itemKey };
}
