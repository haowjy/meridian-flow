/** HTTP client for draft-review read endpoints. */
import { parseDraftItemKey } from "@meridian/contracts";
import type {
  ApplyClick,
  ApplyClickAnswer,
  ApplyClickObservation,
  ApplyClickResult,
  ApplyItemsClick,
  BranchDiscardAllRequest,
  BranchDiscardAllResponse,
  DocumentCommandLookupResponse,
  DocumentDraftHintsResponse,
  DraftDiscardRequest,
  DraftDiscardResponse,
  DraftMetadataResponse,
  ThreadDraftListResponse,
  UnapplyClick,
  UnapplyClickAnswer,
  UndoDiscardAnswer,
  UndoDiscardClick,
} from "@meridian/contracts/branches";
import {
  apiDocumentCommandPath,
  apiProjectBranchApplyPath,
  apiProjectBranchDiscardPath,
  apiProjectBranchDocumentDraftApplyPath,
  apiProjectBranchDocumentDraftDiscardPath,
  apiProjectBranchDocumentDraftPath,
  apiProjectBranchUnapplyPath,
  apiProjectBranchUndoDiscardPath,
  apiProjectDocumentBranchesPath,
  apiProjectDraftsPath,
} from "@meridian/contracts/protocol";

import { getJson, postJson } from "./http-client";

/** The drafts one owner (`work:<id>` or `lineage:<root>`) has pending, one row per document. */
export async function listOwnerDrafts(
  projectId: string,
  owner: string,
): Promise<ThreadDraftListResponse> {
  return getJson<ThreadDraftListResponse>(apiProjectDraftsPath(projectId, owner));
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
  draft: { projectId: string; documentId: string; itemKey: string },
  signal?: AbortSignal,
) {
  return getJson<DraftMetadata>(
    `${apiProjectBranchDocumentDraftPath(draft.projectId, branchOf(draft.itemKey), draft.documentId)}?itemKey=${encodeURIComponent(draft.itemKey)}`,
    { signal },
  );
}
export function applyDraftClick(draft: DraftAddress, body: ApplyClick) {
  return postJson<ApplyClickAnswer>(
    apiProjectBranchDocumentDraftApplyPath(
      draft.projectId,
      branchOf(draft.itemKey),
      draft.documentId,
    ),
    body,
    { signal: AbortSignal.timeout(10_000) },
  );
}
export async function observeDraftClick(body: ApplyClick): Promise<ApplyClickObservation> {
  // Only the typed `none` answer proves absence. A 404 may be a stale route, not an unclaimed id.
  const found = await getJson<DocumentCommandLookupResponse>(
    apiDocumentCommandPath(body.commandId),
    { signal: AbortSignal.timeout(10_000) },
  );
  if (found.status === "none" || found.outcome.status === "never")
    return { status: "none", commandId: body.commandId };
  return found.outcome.result as ApplyClickResult;
}
/** Several nodes, folders included, as one Apply command. */
export function applyItems(projectId: string, branchId: string, body: ApplyItemsClick) {
  return postJson<ApplyClickAnswer>(apiProjectBranchApplyPath(projectId, branchId), body, {
    signal: AbortSignal.timeout(10_000),
  });
}
/** Takes one Apply command back, every document and the tree, by its id. */
export function unapplyCommand(projectId: string, branchId: string, body: UnapplyClick) {
  return postJson<UnapplyClickAnswer>(apiProjectBranchUnapplyPath(projectId, branchId), body, {
    signal: AbortSignal.timeout(10_000),
  });
}
export function unapplyDraftClick(draft: DraftAddress, body: UnapplyClick) {
  return unapplyCommand(draft.projectId, branchOf(draft.itemKey), body);
}
/** Takes a Discard back: `branchId` is the branch it ran on. */
export function undoDiscard(projectId: string, branchId: string, body: UndoDiscardClick) {
  return postJson<UndoDiscardAnswer>(apiProjectBranchUndoDiscardPath(projectId, branchId), body, {
    signal: AbortSignal.timeout(10_000),
  });
}
export function discardDraftItem(draft: DraftAddress, body: DraftDiscardRequest) {
  return postJson<DraftDiscardResponse>(
    apiProjectBranchDocumentDraftDiscardPath(
      draft.projectId,
      branchOf(draft.itemKey),
      draft.documentId,
    ),
    body,
  );
}
export function discardBranchDrafts(draft: DraftAddress, body: BranchDiscardAllRequest) {
  return postJson<BranchDiscardAllResponse>(
    apiProjectBranchDiscardPath(draft.projectId, body.branchId),
    body,
  );
}
/** A draft's branch, named by its item key (`${branchId}:${documentId}`). */
export function branchOf(itemKey: string): string {
  const parsed = parseDraftItemKey(itemKey);
  if (!parsed) throw new Error(`Not a draft item key: ${itemKey}`);
  return parsed.branchId;
}
type DraftAddress = { projectId: string; documentId: string; itemKey: string };
