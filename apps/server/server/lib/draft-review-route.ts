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
import type { FileGrant, FileNeed } from "../domains/file-policy/index.js";
import { emitEvent, unknownToEventPayload } from "../domains/observability/index.js";
import { WorkLifecycleUnavailableError } from "../domains/projects/domain/work-lifecycle.js";
import type { AppServices } from "./app.js";
import { documentTarget, requireFileGrant, withEditGrants } from "./file-access-http.js";
import { throwWorkMutationHttpError } from "./work-http.js";

type DraftRouteServices = {
  projects: Pick<AppServices["projectRepo"], "findById">;
  works: Pick<AppServices["workRepo"], "findById">;
  fileAccess: Pick<AppServices["fileAccess"], "authorize" | "confirmEdit" | "listAccess">;
  documentSync: Pick<AppServices["documentSync"], "draftReview">;
};

export function selectDraftRouteServices(app: AppServices): DraftRouteServices {
  return {
    projects: app.projectRepo,
    works: app.workRepo,
    fileAccess: app.fileAccess,
    documentSync: app.documentSync,
  };
}

export function scheduleDraftCatalogRefresh(
  app: Pick<AppServices, "contextCatalogRefresh" | "eventSink">,
  projectId: ProjectId,
  waitUntil: (task: Promise<void>) => void,
): void {
  waitUntil(
    new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
      try {
        await app.contextCatalogRefresh.refreshProjectDocuments(projectId);
      } catch (cause) {
        emitEvent(app.eventSink, {
          level: "error",
          source: "draft-review",
          name: "CatalogRefreshFailure",
          payload: { projectId, ...unknownToEventPayload(cause) },
        });
      }
    }),
  );
}

export async function requireDraftWorkAccess(
  deps: DraftRouteServices,
  input: { projectId: ProjectId; workId: WorkId; userId: UserId },
): Promise<void> {
  const project = await deps.projects.findById(input.projectId);
  if (!project || project.userId !== input.userId || project.deletedAt) {
    throw createError({ statusCode: 404, message: "Draft not found" });
  }
  const work = await deps.works.findById(input.workId);
  if (!work || work.projectId !== input.projectId) {
    throw createError({ statusCode: 404, message: "Draft not found" });
  }
}

/**
 * The writer's grant on one draft (file-access §2, §4): preview reads it;
 * Discard edits it; Apply edits it and the live document, so an archived
 * Work's frozen draft can't be applied (D30).
 */
async function draftGrants<N extends FileNeed>(
  deps: DraftRouteServices,
  input: { projectId: ProjectId; workId: WorkId; documentId: DocumentId; userId: UserId },
  need: N,
  options: { live?: boolean } = {},
): Promise<FileGrant<N>[]> {
  await requireDraftWorkAccess(deps, input);
  const draft = await requireFileGrant(
    deps.fileAccess,
    input.userId,
    { kind: "draft", documentId: input.documentId, workId: input.workId },
    need,
  );
  if (draft.facts.projectId !== input.projectId) {
    throw createError({ statusCode: 404, message: "Draft not found" });
  }
  if (!options.live) return [draft];
  return [
    draft,
    await requireFileGrant(deps.fileAccess, input.userId, documentTarget(input.documentId), need),
  ];
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
  await draftGrants(deps, input, "read");
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
  const grants = await draftGrants(deps, input, "edit", { live: true });
  const result = await withEditGrants(deps.fileAccess, grants, () =>
    callDraftReview(deps.documentSync.draftReview.applyWorkDraft(input)),
  );
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
  const grants = await draftGrants(deps, input, "edit");
  return withEditGrants(deps.fileAccess, grants, () =>
    callDraftReview(deps.documentSync.draftReview.discardWorkDraft(input)),
  );
}

function toWireReviewOperation<T extends { closureUpdateIds?: unknown; sourceUpdateIds?: unknown }>(
  operation: T,
) {
  const {
    closureUpdateIds: _closureUpdateIds,
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
    if (cause instanceof WorkLifecycleUnavailableError) throwWorkMutationHttpError(cause);
    if (cause instanceof Error && cause.message === "draft_not_found") {
      throw createError({ statusCode: 404, message: "Draft not found" });
    }
    throw cause;
  }
}

/** The drafts whose documents the writer can still read (file-access §6). */
async function filterAccessibleDrafts<T extends { documentId: DocumentId }>(
  deps: DraftRouteServices,
  input: { drafts: T[]; projectId: ProjectId; userId: UserId },
): Promise<T[]> {
  const access = await deps.fileAccess.listAccess(
    { accountId: input.userId },
    input.drafts.map((draft) => draft.documentId),
  );
  return input.drafts.filter((draft) => access.has(draft.documentId));
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
