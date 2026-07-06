/** Route core for authenticated AI draft preview/accept/reject over Work-scoped draft documents. */

import type {
  DraftAcceptResponse,
  DraftJournalResponse,
  DraftPreviewResponse,
  DraftRejectResponse,
  DraftUndoResponse,
  ThreadDraftListItem,
  ThreadDraftListResponse,
} from "@meridian/contracts/drafts";
import { branchRoomName } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId, UserId, WorkId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import type { AppServices } from "./app.js";

type DraftRouteServices = {
  projects: Pick<AppServices["projectRepo"], "findById">;
  works: Pick<AppServices["workRepo"], "findById">;
  documentAccess: Pick<
    AppServices["documentAccess"],
    "canAccessDocument" | "canAccessProjectDocument"
  >;
  documentSync: Pick<AppServices["documentSync"], "draftReview" | "draftLifecycleFeed">;
};

export function selectDraftRouteServices(app: AppServices): DraftRouteServices {
  return {
    projects: app.projectRepo,
    works: app.workRepo,
    documentAccess: app.documentAccess,
    documentSync: app.documentSync,
  };
}

export async function requireDraftWorkAccess(
  deps: DraftRouteServices,
  input: { projectId: ProjectId; workId: WorkId; documentId?: DocumentId; userId: UserId },
): Promise<void> {
  const project = await deps.projects.findById(input.projectId);
  if (!project || project.userId !== input.userId || project.deletedAt) {
    throw createError({ statusCode: 404, message: "Draft not found" });
  }
  const work = await deps.works.findById(input.workId);
  if (!work || work.projectId !== input.projectId) {
    throw createError({ statusCode: 404, message: "Draft not found" });
  }
  if (input.documentId) {
    const [hasDocumentAccess, isProjectDocument] = await Promise.all([
      deps.documentAccess.canAccessDocument(input.userId, input.documentId),
      deps.documentAccess.canAccessProjectDocument(input.userId, input.documentId, input.projectId),
    ]);
    if (!hasDocumentAccess || !isProjectDocument) {
      throw createError({ statusCode: 404, message: "Draft not found" });
    }
  }
}

export async function handleWorkDraftListRequest(
  deps: DraftRouteServices,
  input: { projectId: ProjectId; workId: WorkId; userId: UserId },
): Promise<ThreadDraftListResponse> {
  await requireDraftWorkAccess(deps, input);
  const drafts = await deps.documentSync.draftReview.list({
    workId: input.workId,
  });
  const lifecycleStates = await deps.documentSync.draftLifecycleFeed.listLifecycleStateByWork({
    workId: input.workId,
  });
  const lifecycleByDraftId = new Map(lifecycleStates.map((state) => [state.draftId, state]));
  const visibleDrafts = await filterAccessibleDrafts(deps, {
    drafts,
    projectId: input.projectId,
    userId: input.userId,
  });
  return {
    drafts: visibleDrafts.map((draft) =>
      serializeThreadDraft(draft, lifecycleByDraftId.get(draft.id)),
    ),
  };
}

export async function handleWorkDraftPreviewRequest(
  deps: DraftRouteServices,
  input: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    draftId?: string;
    userId: UserId;
  },
): Promise<DraftPreviewResponse> {
  await requireDraftWorkAccess(deps, input);
  const preview = await callDraftReview(deps.documentSync.draftReview.preview(input));
  if (preview.status === "gone") return preview;

  const base = {
    status: "active" as const,
    ...(preview.branchId
      ? {
          branchId: preview.branchId,
          reviewRoomName: branchRoomName(preview.branchId, preview.draftRevisionToken),
        }
      : { draftId: preview.draftId }),
    live: preview.live,
    preview: preview.markdown,
    liveRevisionToken: preview.liveRevisionToken,
    draftRevisionToken: preview.draftRevisionToken,
    ...(preview.notice ? { notice: preview.notice } : {}),
    ...(preview.isNewDocument ? { isNewDocument: true } : {}),
  };
  return {
    ...base,
    inlineModelPresent: true,
    operations: preview.operations.map(toWireReviewOperation),
    hunks: preview.hunks,
  };
}

export async function handleWorkDraftJournalRequest(
  deps: DraftRouteServices,
  input: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    draftId: string;
    revisionToken: number;
    userId: UserId;
  },
): Promise<DraftJournalResponse> {
  await requireDraftWorkAccess(deps, input);
  const result = await callDraftReview(deps.documentSync.draftReview.journal(input));
  if (result.status === "not_found") {
    throw createError({ statusCode: 404, message: "Draft not found" });
  }
  if (result.draftRevisionToken !== input.revisionToken) {
    throw createError({
      statusCode: 409,
      message: "Draft revision is stale",
      data: { code: "stale_revision", currentRevisionToken: result.draftRevisionToken },
    });
  }
  return {
    draftId: input.draftId,
    draftRevisionToken: result.draftRevisionToken,
    checkpoint: result.checkpoint ? bytesToBase64(result.checkpoint) : null,
    updates: result.updates.map((update) => ({
      seq: update.seq,
      update: bytesToBase64(update.update),
      ...(update.updateKind ? { updateKind: update.updateKind } : {}),
    })),
  };
}

export async function handleWorkDraftAcceptRequest(
  deps: DraftRouteServices,
  input: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    draftId?: string;
    branchId?: string;
    userId: UserId;
    confirmOverlap?: boolean;
    confirmedLiveRevisionToken?: number;
    draftRevisionToken: number;
    operationIds?: string[];
    confirmedClosureOperationIds?: string[];
  },
): Promise<DraftAcceptResponse> {
  await requireDraftWorkAccess(deps, input);
  if (input.branchId && input.draftId) {
    throw createError({ statusCode: 400, message: "Send branchId or draftId, not both" });
  }
  const result = await callDraftReview(deps.documentSync.draftReview.accept(input));
  return mapAcceptResult(result);
}

export async function handleWorkDraftRejectRequest(
  deps: DraftRouteServices,
  input: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    draftId?: string;
    branchId?: string;
    userId: UserId;
  },
): Promise<DraftRejectResponse> {
  await requireDraftWorkAccess(deps, input);
  if (input.branchId && input.draftId) {
    throw createError({ statusCode: 400, message: "Send branchId or draftId, not both" });
  }
  const result = await callDraftReview(deps.documentSync.draftReview.reject(input));
  if (result.status === "discarded")
    return result.branchId ? { status: "discarded", branchId: result.branchId } : result;
  throw createError({ statusCode: 404, message: "Draft not found" });
}

export async function handleWorkDraftUndoAcceptRequest(
  deps: DraftRouteServices,
  input: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    draftId: string;
    userId: UserId;
    writeId?: string;
  },
): Promise<DraftUndoResponse> {
  await requireDraftWorkAccess(deps, input);
  const result = await callDraftReview(deps.documentSync.draftReview.undoAccept(input));
  return mapUndoResult(result);
}

export async function handleWorkDraftUndoRejectRequest(
  deps: DraftRouteServices,
  input: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    draftId: string;
    userId: UserId;
  },
): Promise<DraftUndoResponse> {
  await requireDraftWorkAccess(deps, input);
  const result = await callDraftReview(deps.documentSync.draftReview.undoReject(input));
  return mapUndoResult(result);
}

function toWireReviewOperation<
  T extends { directionalClosure?: unknown; actorUserId?: unknown; sourceUpdateIds?: unknown },
>(operation: T) {
  const {
    directionalClosure: _directionalClosure,
    actorUserId: _actorUserId,
    sourceUpdateIds: _sourceUpdateIds,
    ...wire
  } = operation;
  return wire;
}

async function callDraftReview<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("read_failed:")) {
      throwReadFailure(cause.message.slice("read_failed:".length));
    }
    if (cause instanceof Error && cause.message === "draft_not_found") {
      throw createError({ statusCode: 404, message: "Draft not found" });
    }
    throw cause;
  }
}

function mapAcceptResult(
  result: Awaited<ReturnType<DraftRouteServices["documentSync"]["draftReview"]["accept"]>>,
): DraftAcceptResponse {
  if (result.status === "applied")
    return result.branchId
      ? { status: "applied", branchId: result.branchId }
      : { status: "applied", draftId: result.draftId };
  if (result.status === "partial_applied") {
    return { status: "partial_applied", draftId: result.draftId, writeId: result.writeId };
  }
  if (result.status === "closure_confirmation_required") return result;
  if (result.status === "stale_draft") return result;
  if (result.status === "causal_dependency") return result;
  if (result.status === "cannot_place") {
    return { status: "cannot_place", draftId: result.draftId };
  }
  if (result.status === "overlap") {
    return {
      status: "overlap",
      draftId: result.draftId,
      liveRevisionToken: result.liveRevisionToken,
      live: result.live,
      preview: result.preview,
    };
  }
  if (result.status === "in_progress") {
    throw createError({ statusCode: 409, message: "Draft accept already in progress" });
  }
  if (result.status === "discarded") {
    throw createError({ statusCode: 410, message: "Draft is no longer active" });
  }
  if (result.status === "invalid_created_document") {
    throw createError({
      statusCode: 409,
      message: "Draft was created by a response that did not commit",
      data: { code: "invalid_created_document" },
    });
  }
  throw createError({ statusCode: 404, message: "Draft not found" });
}

function mapUndoResult(
  result: Awaited<ReturnType<DraftRouteServices["documentSync"]["draftReview"]["undoAccept"]>>,
): DraftUndoResponse {
  if (result.status === "reactivated") return result;
  if (result.status === "expired") {
    throw createError({ statusCode: 410, message: "Draft acceptance can no longer be undone" });
  }
  if (result.status === "conflict") {
    throw createError({ statusCode: 409, message: messageForUndoConflict(result.reason) });
  }
  throw createError({ statusCode: 404, message: "Draft not found" });
}

function messageForUndoConflict(
  reason: "active_draft" | "reversal_failed" | "reactivation_in_progress" | undefined,
): string {
  switch (reason) {
    case "reversal_failed":
      return "Draft undo could not safely reverse the accepted changes";
    case "reactivation_in_progress":
      return "Draft undo is already in progress";
    default:
      return "Another active draft exists for this document";
  }
}

async function filterAccessibleDrafts<T extends { documentId: DocumentId }>(
  deps: DraftRouteServices,
  input: {
    drafts: T[];
    projectId: ProjectId;
    userId: UserId;
  },
): Promise<T[]> {
  const checks: Array<T | null> = await Promise.all(
    input.drafts.map(async (draft): Promise<T | null> => {
      const [hasDocumentAccess, isProjectDocument] = await Promise.all([
        deps.documentAccess.canAccessDocument(input.userId, draft.documentId),
        deps.documentAccess.canAccessProjectDocument(
          input.userId,
          draft.documentId,
          input.projectId,
        ),
      ]);
      return hasDocumentAccess && isProjectDocument ? draft : null;
    }),
  );
  return checks.filter((draft): draft is T => draft !== null);
}

function serializeThreadDraft(
  draft: {
    id: string;
    documentId: string;
    documentName: string | null;
    contextPath: string | null;
    status: "active" | "applied" | "discarded";
    lastActorTurnId: string | null;
    updatedAt: Date;
    appliedAt: Date | null;
    discardedAt: Date | null;
    wordsAdded?: number | null;
    wordsRemoved?: number | null;
    createdDocument?: boolean;
  },
  lifecycle?: {
    partialAcceptedOperationCount: number | null;
    proposedOperationCount: number | null;
  },
): ThreadDraftListItem {
  return {
    draftId: draft.id,
    documentId: draft.documentId,
    documentName: draft.documentName,
    contextPath: draft.contextPath,
    status: draft.status,
    lastActorTurnId: draft.lastActorTurnId,
    updatedAt: draft.updatedAt.toISOString(),
    appliedAt: draft.appliedAt?.toISOString() ?? null,
    discardedAt: draft.discardedAt?.toISOString() ?? null,
    partialAcceptedOperationCount: lifecycle?.partialAcceptedOperationCount ?? null,
    proposedOperationCount: lifecycle?.proposedOperationCount ?? null,
    wordsAdded: draft.status === "active" ? (draft.wordsAdded ?? null) : null,
    wordsRemoved: draft.status === "active" ? (draft.wordsRemoved ?? null) : null,
    ...(draft.createdDocument ? { isNewDocument: true } : {}),
  };
}

function throwReadFailure(code: string): never {
  if (code === "not_found") throw createError({ statusCode: 404, message: "Document not found" });
  throw createError({ statusCode: 500, message: "Document markdown is unavailable" });
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
