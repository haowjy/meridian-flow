/** Route core for authenticated AI draft preview/Apply/Discard over Work-scoped draft documents. */

import type {
  DraftApplyResponse,
  DraftDiscardResponse,
  DraftPreviewResponse,
  ThreadDraftListItem,
  ThreadDraftListResponse,
} from "@meridian/contracts/drafts";
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
  documentSync: Pick<AppServices["documentSync"], "draftReview">;
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
    projectId: input.projectId,
    workId: input.workId,
  });
  const visibleDrafts = await filterAccessibleDrafts(deps, {
    drafts,
    projectId: input.projectId,
    userId: input.userId,
  });
  return {
    drafts: visibleDrafts.map((draft) => serializeThreadDraft(draft, undefined)),
  };
}

export async function handleWorkDraftPreviewRequest(
  deps: DraftRouteServices,
  input: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    draftId: string;
    userId: UserId;
  },
): Promise<DraftPreviewResponse> {
  await requireDraftWorkAccess(deps, input);
  const preview = await callDraftReview(deps.documentSync.draftReview.preview(input));
  if (preview.status === "gone") return preview;

  const base = {
    status: "active" as const,
    draftId: preview.draftId,
    reviewRoomName: preview.reviewRoomName,
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

export async function handleApplyWorkDraftRequest(
  deps: DraftRouteServices,
  input: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    draftId: string;
    userId: UserId;
    signal?: AbortSignal;
  },
): Promise<DraftApplyResponse> {
  await requireDraftWorkAccess(deps, input);
  const result = await callDraftReview(deps.documentSync.draftReview.applyWorkDraft(input));
  if (result.status === "applied") return result;
  throw createError({ statusCode: 404, message: "Draft not found" });
}

export async function handleDiscardWorkDraftRequest(
  deps: DraftRouteServices,
  input: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    draftId: string;
    userId: UserId;
    operationIds?: string[];
  },
): Promise<DraftDiscardResponse> {
  await requireDraftWorkAccess(deps, input);
  return callDraftReview(deps.documentSync.draftReview.discardWorkDraft(input));
}

function toWireReviewOperation<T extends { discardUpdateIds?: unknown; sourceUpdateIds?: unknown }>(
  operation: T,
) {
  const {
    discardUpdateIds: _discardUpdateIds,
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
    draftId: string;
    documentId: string;
    documentName: string | null;
    contextPath: string | null;
    status: "active";
    lastActorTurnId: string | null;
    updatedAt: Date;
    wordsAdded?: number | null;
    wordsRemoved?: number | null;
    createdDocument?: boolean;
  },
  lifecycle?: {
    proposedOperationCount: number | null;
  },
): ThreadDraftListItem {
  return {
    draftId: draft.draftId,
    documentId: draft.documentId,
    documentName: draft.documentName,
    contextPath: draft.contextPath,
    status: draft.status,
    lastActorTurnId: draft.lastActorTurnId,
    updatedAt: draft.updatedAt.toISOString(),
    proposedOperationCount: lifecycle?.proposedOperationCount ?? null,
    wordsAdded: draft.wordsAdded ?? null,
    wordsRemoved: draft.wordsRemoved ?? null,
    ...(draft.createdDocument ? { isNewDocument: true } : {}),
  };
}

function throwReadFailure(code: string): never {
  if (code === "not_found") throw createError({ statusCode: 404, message: "Document not found" });
  throw createError({ statusCode: 500, message: "Document markdown is unavailable" });
}
