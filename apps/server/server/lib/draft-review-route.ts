/** Route core for authenticated AI draft preview/Apply/Discard over Work-scoped draft documents. */

import type {
  DraftApplyChangesRequest,
  DraftApplyChangesResponse,
  DraftApplyResponse,
  DraftDiscardResponse,
  DraftPreviewResponse,
  ReviewOperation,
  ThreadDraftListItem,
  ThreadDraftListResponse,
} from "@meridian/contracts/drafts";
import type { DocumentId, ProjectId, UserId, WorkId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import type { DraftReviewOperationInternal } from "../domains/collab/domain/draft-review-types.js";
import type { DraftDiscardCommand } from "../domains/collab/index.js";
import type { FileGrant, FileNeed } from "../domains/file-policy/index.js";
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
  app: Pick<AppServices, "contextCatalogRefresh">,
  projectId: ProjectId,
  waitUntil: (task: Promise<void>) => void,
): void {
  waitUntil(app.contextCatalogRefresh.refreshProjectDocuments(projectId));
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
    drafts: visibleDrafts.map((draft) => serializeThreadDraft(draft)),
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
    draftGeneration: preview.draftGeneration,
    reviewRoomName: preview.reviewRoomName,
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

export async function handleApplyWorkDraftChangesRequest(
  deps: DraftRouteServices,
  input: DraftApplyChangesRequest & {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    userId: UserId;
    signal?: AbortSignal;
  },
): Promise<DraftApplyChangesResponse> {
  const grants = await draftGrants(deps, input, "edit", { live: true });
  return withEditGrants(deps.fileAccess, grants, () =>
    callDraftReview(deps.documentSync.draftReview.applyWorkDraftChanges(input)),
  );
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
    liveRevisionToken?: string;
    draftRevisionToken?: string;
  },
): Promise<DraftDiscardResponse> {
  const selection = parseDraftDiscardSelection(input);
  if (selection.status === "stale") return { status: "stale", draftId: input.draftId };
  const grants = await draftGrants(deps, input, "edit");
  return withEditGrants(deps.fileAccess, grants, () =>
    callDraftReview(
      deps.documentSync.draftReview.discardWorkDraft({
        projectId: input.projectId,
        workId: input.workId,
        documentId: input.documentId,
        draftId: input.draftId,
        userId: input.userId,
        ...selection.command,
      }),
    ),
  );
}

function toWireReviewOperation(operation: DraftReviewOperationInternal): ReviewOperation {
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

function serializeThreadDraft(draft: {
  draftId: string;
  documentId: string;
  documentName: string | null;
  contextPath: string | null;
  status: "active";
  draftGeneration: number;
  lastActorTurnId: string | null;
  actorThreads: ThreadDraftListItem["actorThreads"];
  updatedAt: Date;
  createdDocument?: boolean;
}): ThreadDraftListItem {
  return {
    draftId: draft.draftId,
    documentId: draft.documentId,
    documentName: draft.documentName,
    contextPath: draft.contextPath,
    status: draft.status,
    draftGeneration: draft.draftGeneration,
    lastActorTurnId: draft.lastActorTurnId,
    actorThreads: draft.actorThreads,
    updatedAt: draft.updatedAt.toISOString(),
    ...(draft.createdDocument ? { isNewDocument: true } : {}),
  };
}

function throwReadFailure(code: string): never {
  if (code === "not_found") throw createError({ statusCode: 404, message: "Document not found" });
  throw createError({ statusCode: 500, message: "Document markdown is unavailable" });
}

/** Presence chooses selective Discard; malformed selections can never widen its scope. */
export function parseDraftDiscardSelection(input: {
  operationIds?: unknown;
  liveRevisionToken?: unknown;
  draftRevisionToken?: unknown;
}): { status: "ready"; command: DraftDiscardCommand } | { status: "stale" } {
  if (Object.hasOwn(input, "operationIds")) {
    if (
      !Array.isArray(input.operationIds) ||
      input.operationIds.length === 0 ||
      input.operationIds.some((id) => typeof id !== "string" || !id.trim())
    )
      throw createError({
        statusCode: 400,
        message: "operationIds must be a nonempty array of strings",
      });
    if (
      typeof input.liveRevisionToken !== "string" ||
      !input.liveRevisionToken ||
      typeof input.draftRevisionToken !== "string" ||
      !input.draftRevisionToken
    )
      return { status: "stale" };
    return {
      status: "ready",
      command: {
        operationIds: input.operationIds,
        liveRevisionToken: input.liveRevisionToken,
        draftRevisionToken: input.draftRevisionToken,
      },
    };
  }
  if (Object.hasOwn(input, "liveRevisionToken") || Object.hasOwn(input, "draftRevisionToken"))
    throw createError({ statusCode: 400, message: "revision tokens require operationIds" });
  return { status: "ready", command: {} };
}
