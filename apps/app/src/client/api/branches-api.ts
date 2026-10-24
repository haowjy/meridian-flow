/** HTTP client for draft-review read endpoints. */
import type {
  ApplyClick,
  ApplyClickAnswer,
  ApplyClickObservation,
  BranchDiscardAllRequest,
  BranchDiscardAllResponse,
  DocumentDraftHintsResponse,
  DraftDiscardRequest,
  DraftDiscardResponse,
  DraftMetadataResponse,
  ThreadDraftListResponse,
  UnapplyClick,
  UnapplyClickAnswer,
} from "@meridian/contracts/branches";
import {
  apiProjectDocumentBranchesPath,
  apiProjectWorkBranchCommandPath,
  apiProjectWorkBranchesDiscardPath,
  apiProjectWorkBranchesPath,
  apiProjectWorkDocumentDraftApplyPath,
  apiProjectWorkDocumentDraftDiscardPath,
  apiProjectWorkDocumentDraftPath,
  apiProjectWorkDocumentDraftUnapplyPath,
} from "@meridian/contracts/protocol";

import { getJson, postJson } from "./http-client";

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

/** SQL-only addressed lookup. This also resolves drafts with no current text differences. */
export type DraftMetadata = DraftMetadataResponse;
export function getDraftMetadata(
  draft: { projectId: string; workId: string; documentId: string; itemKey: string },
  signal?: AbortSignal,
) {
  return getJson<DraftMetadata>(
    `${apiProjectWorkDocumentDraftPath(draft.projectId, draft.workId, draft.documentId)}?itemKey=${encodeURIComponent(draft.itemKey)}`,
    { signal },
  );
}
export function applyDraftClick(draft: DraftAddress, body: ApplyClick) {
  return postJson<ApplyClickAnswer>(
    apiProjectWorkDocumentDraftApplyPath(draft.projectId, draft.workId, draft.documentId),
    body,
    { signal: AbortSignal.timeout(10_000) },
  );
}
export function observeDraftClick(
  draft: DraftAddress,
  body: ApplyClick,
): Promise<ApplyClickObservation> {
  // Only the typed `none` answer proves absence. A 404 may be lost Work access, not an unclaimed id.
  return getJson<ApplyClickObservation>(
    apiProjectWorkBranchCommandPath(draft.projectId, draft.workId, body.commandId),
    { signal: AbortSignal.timeout(10_000) },
  );
}
export function unapplyDraftClick(draft: DraftAddress, body: UnapplyClick) {
  return postJson<UnapplyClickAnswer>(
    apiProjectWorkDocumentDraftUnapplyPath(draft.projectId, draft.workId, draft.documentId),
    body,
    { signal: AbortSignal.timeout(10_000) },
  );
}
export function discardCreatedDraft(draft: DraftAddress, body: DraftDiscardRequest) {
  return postJson<DraftDiscardResponse>(
    apiProjectWorkDocumentDraftDiscardPath(draft.projectId, draft.workId, draft.documentId),
    body,
  );
}
export function discardWorkDrafts(draft: DraftAddress, body: BranchDiscardAllRequest) {
  return postJson<BranchDiscardAllResponse>(
    apiProjectWorkBranchesDiscardPath(draft.projectId, draft.workId),
    body,
  );
}
type DraftAddress = { projectId: string; workId: string; documentId: string };
