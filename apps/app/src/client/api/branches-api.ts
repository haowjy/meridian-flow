/** HTTP client for draft-review read endpoints. */
import { parseDraftItemKey } from "@meridian/contracts";
import type {
  ApplyClick,
  ApplyClickAnswer,
  ApplyClickObservation,
  ApplyClickResult,
  ApplyItemsClick,
  BranchDiscardRequest,
  BranchDiscardResponse,
  ClosedDraftsRequest,
  ClosedDraftsResponse,
  DocumentDraftHintsResponse,
  DraftDiscardRequest,
  DraftDiscardResponse,
  DraftMetadataResponse,
  DraftsProvenanceRequest,
  DraftsProvenanceResponse,
  ThreadDraftListResponse,
  UnapplyClick,
  UnapplyClickAnswer,
  UndoDiscardAnswer,
  UndoDiscardClick,
} from "@meridian/contracts/branches";
import { CLOSED_DRAFTS_MAX } from "@meridian/contracts/branches";
import type { CommandLookupResponse, CommandRunning } from "@meridian/contracts/commands";
import {
  apiClosedDraftsPath,
  apiCommandPath,
  apiProjectBranchApplyPath,
  apiProjectBranchDiscardPath,
  apiProjectBranchDocumentDraftApplyPath,
  apiProjectBranchDocumentDraftDiscardPath,
  apiProjectBranchDocumentDraftPath,
  apiProjectBranchUnapplyPath,
  apiProjectBranchUndoDiscardPath,
  apiProjectDocumentBranchesPath,
  apiProjectDraftsPath,
  apiProjectDraftsProvenancePath,
} from "@meridian/contracts/protocol";

import { getJson, postJson } from "./http-client";

/**
 * The drafts one owner (`work:<id>` or `lineage:<root>`) has pending, one row per document.
 * `readAt` is when the read started, the time its rows speak for (`DraftMetadataAnswer`).
 */
export type OwnerDraftList = ThreadDraftListResponse & { readAt: number };
export async function listOwnerDrafts(projectId: string, owner: string): Promise<OwnerDraftList> {
  const readAt = Date.now();
  return {
    ...(await getJson<ThreadDraftListResponse>(apiProjectDraftsPath(projectId, owner))),
    readAt,
  };
}

/** Which of these draft ids the server has closed, asked in as many requests as the limit needs. */
export async function listClosedDrafts(draftIds: string[]): Promise<Set<string>> {
  const closed = new Set<string>();
  for (let at = 0; at < draftIds.length; at += CLOSED_DRAFTS_MAX) {
    const answer = await postJson<ClosedDraftsResponse>(apiClosedDraftsPath(), {
      draftIds: draftIds.slice(at, at + CLOSED_DRAFTS_MAX),
    } satisfies ClosedDraftsRequest);
    for (const id of answer.closed) closed.add(id);
  }
  return closed;
}

/** The authorship evidence of an owner's drafts, many in one request. */
export function readDraftsProvenance(projectId: string, request: DraftsProvenanceRequest) {
  return postJson<DraftsProvenanceResponse>(apiProjectDraftsProvenancePath(projectId), request);
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
/**
 * Posts an Apply or Un-Apply, and again under the same id after a timeout and for as long as the
 * server says the first request is still running: a large Apply outlasts one request's timeout,
 * and the resend waits on it server-side instead of applying again. A resend that times out too
 * means the server isn't answering: that throws, as any lost request does.
 */
async function postCommand<A>(url: string, body: unknown): Promise<A> {
  let timedOut = false;
  for (;;) {
    let answer: A | CommandRunning;
    try {
      answer = await postJson<A | CommandRunning>(url, body, {
        signal: AbortSignal.timeout(10_000),
      });
    } catch (cause) {
      if (timedOut || (cause as { name?: unknown } | null)?.name !== "TimeoutError") throw cause;
      timedOut = true;
      continue;
    }
    if ((answer as { status?: unknown }).status !== "running") return answer as A;
    timedOut = false;
  }
}
export function applyDraftClick(draft: DraftAddress, body: ApplyClick) {
  return postCommand<ApplyClickAnswer>(
    apiProjectBranchDocumentDraftApplyPath(
      draft.projectId,
      branchOf(draft.itemKey),
      draft.documentId,
    ),
    body,
  );
}
export async function observeDraftClick(body: ApplyClick): Promise<ApplyClickObservation> {
  // Only the typed `none` answer proves absence. A 404 may be a stale route, not an unclaimed id.
  const found = await getJson<CommandLookupResponse>(apiCommandPath(body.commandId), {
    signal: AbortSignal.timeout(10_000),
  });
  if (found.status === "none" || found.outcome.status === "never")
    return { status: "none", commandId: body.commandId };
  return found.outcome.result as ApplyClickResult;
}
/** Several nodes, folders included, as one Apply command. */
export function applyItems(projectId: string, branchId: string, body: ApplyItemsClick) {
  return postCommand<ApplyClickAnswer>(apiProjectBranchApplyPath(projectId, branchId), body);
}
/** Takes one Apply command back, every document and the tree, by its id. */
export function unapplyCommand(projectId: string, branchId: string, body: UnapplyClick) {
  return postCommand<UnapplyClickAnswer>(apiProjectBranchUnapplyPath(projectId, branchId), body);
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
/** The branch's Discard: Discard all, or a selection of nodes, as one command. */
export function discardBranch(projectId: string, branchId: string, body: BranchDiscardRequest) {
  return postJson<BranchDiscardResponse>(apiProjectBranchDiscardPath(projectId, branchId), body);
}
/** A draft's branch, named by its item key (`${branchId}:${documentId}`). */
export function branchOf(itemKey: string): string {
  const parsed = parseDraftItemKey(itemKey);
  if (!parsed) throw new Error(`Not a draft item key: ${itemKey}`);
  return parsed.branchId;
}
type DraftAddress = { projectId: string; documentId: string; itemKey: string };
