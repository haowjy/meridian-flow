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
import type { DocumentId, ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import type { AppServices } from "./app.js";

type DraftRouteServices = {
  projects: Pick<AppServices["projectRepo"], "findById">;
  works: Pick<AppServices["workRepo"], "findById">;
  documentAccess: Pick<
    AppServices["documentAccess"],
    "canAccessDocument" | "canAccessProjectDocument"
  >;
  documentSync: Pick<AppServices["documentSync"], "readAsMarkdown"> & {
    drafts: Pick<
      AppServices["documentSync"]["drafts"],
      | "getDraft"
      | "getActiveDraftByWork"
      | "previewDraft"
      | "acceptDraft"
      | "rejectDraft"
      | "undoAcceptDraft"
      | "undoRejectDraft"
      | "listReviewableDraftsByWork"
      | "getDraftJournal"
      | "resolvePrimaryThreadForWork"
      | "resolveDraftThreadId"
    >;
  };
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
  const drafts = await deps.documentSync.drafts.listReviewableDraftsByWork({
    workId: input.workId,
  });
  const visibleDrafts = await filterAccessibleDrafts(deps, {
    drafts,
    projectId: input.projectId,
    userId: input.userId,
  });
  return { drafts: visibleDrafts.map(serializeThreadDraft) };
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
  const live = await deps.documentSync.readAsMarkdown(input.documentId);
  if (!live.ok) throwReadFailure(live.error.code);

  const draft = await deps.documentSync.drafts.getActiveDraftByWork({
    documentId: input.documentId,
    workId: input.workId,
  });
  if (!draft) return { status: "gone", live: live.value };
  if (input.draftId && draft.id !== input.draftId) return { status: "gone", live: live.value };

  const preview = await deps.documentSync.drafts.previewDraft({
    documentId: input.documentId,
    draftId: draft.id,
  });

  const base = {
    status: "active" as const,
    draftId: draft.id,
    live: preview.live,
    preview: preview.markdown,
    liveRevisionToken: preview.liveRevisionToken,
    draftRevisionToken: preview.draftRevisionToken,
  };
  if (preview.operations && preview.hunks) {
    return {
      ...base,
      inlineModelPresent: true,
      operations: preview.operations,
      hunks: preview.hunks,
    };
  }
  return { ...base, inlineModelPresent: false };
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
  await requireDraftForWork(deps, input);
  const activeDraft = await deps.documentSync.drafts.getActiveDraftByWork({
    documentId: input.documentId,
    workId: input.workId,
  });
  if (!activeDraft || activeDraft.id !== input.draftId) {
    throw createError({ statusCode: 404, message: "Draft not found" });
  }

  const result = await deps.documentSync.drafts.getDraftJournal({
    documentId: input.documentId,
    draftId: input.draftId,
  });
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
    })),
  };
}

export async function handleWorkDraftAcceptRequest(
  deps: DraftRouteServices,
  input: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    draftId: string;
    userId: UserId;
    confirmOverlap?: boolean;
    confirmedLiveRevisionToken?: number;
    draftRevisionToken: number;
    operationIds?: string[];
    confirmedClosureOperationIds?: string[];
  },
): Promise<DraftAcceptResponse> {
  const threadId = await requireDraftForWork(deps, input);
  const result = await deps.documentSync.drafts.acceptDraft({ ...input, threadId });
  return mapAcceptResult(result);
}

export async function handleWorkDraftRejectRequest(
  deps: DraftRouteServices,
  input: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    draftId: string;
    userId: UserId;
  },
): Promise<DraftRejectResponse> {
  const threadId = await requireDraftForWork(deps, input);
  const result = await deps.documentSync.drafts.rejectDraft({ ...input, threadId });
  if (result.status === "discarded") return result;
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
  const threadId = await requireDraftForWork(deps, input);
  const result = await deps.documentSync.drafts.undoAcceptDraft({ ...input, threadId });
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
  const threadId = await requireDraftForWork(deps, input);
  const result = await deps.documentSync.drafts.undoRejectDraft({ ...input, threadId });
  return mapUndoResult(result);
}

async function requireDraftForWork(
  deps: DraftRouteServices,
  input: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    draftId: string;
    userId: UserId;
  },
): Promise<ThreadId> {
  await requireDraftWorkAccess(deps, input);
  const draft = await deps.documentSync.drafts.getDraft(input.draftId);
  if (!draft || draft.workId !== input.workId || draft.documentId !== input.documentId) {
    throw createError({ statusCode: 404, message: "Draft not found" });
  }
  const threadId =
    (await deps.documentSync.drafts.resolvePrimaryThreadForWork(input.workId)) ??
    (await deps.documentSync.drafts.resolveDraftThreadId(input.draftId));
  if (!threadId) throw createError({ statusCode: 404, message: "Draft not found" });
  return threadId;
}

function mapAcceptResult(
  result: Awaited<ReturnType<DraftRouteServices["documentSync"]["drafts"]["acceptDraft"]>>,
): DraftAcceptResponse {
  if (result.status === "applied") return { status: "applied", draftId: result.draftId };
  if (result.status === "partial_applied") {
    return { status: "partial_applied", draftId: result.draftId, writeId: result.writeId };
  }
  if (result.status === "closure_confirmation_required") return result;
  if (result.status === "stale_draft") return result;
  if (result.status === "causal_dependency") return result;
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
  result: Awaited<ReturnType<DraftRouteServices["documentSync"]["drafts"]["undoAcceptDraft"]>>,
): DraftUndoResponse {
  if (result.status === "reactivated") return result;
  if (result.status === "expired") {
    throw createError({ statusCode: 410, message: "Draft acceptance can no longer be undone" });
  }
  if (result.status === "conflict") {
    throw createError({
      statusCode: 409,
      message: "Another active draft exists for this document",
    });
  }
  throw createError({ statusCode: 404, message: "Draft not found" });
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

function serializeThreadDraft(draft: {
  id: string;
  documentId: string;
  documentName: string | null;
  contextPath: string | null;
  status: "active" | "applied" | "discarded";
  lastActorTurnId: string | null;
  updatedAt: Date;
}): ThreadDraftListItem {
  return {
    draftId: draft.id,
    documentId: draft.documentId,
    documentName: draft.documentName,
    contextPath: draft.contextPath,
    status: draft.status,
    lastActorTurnId: draft.lastActorTurnId,
    updatedAt: draft.updatedAt.toISOString(),
  };
}

function throwReadFailure(code: string): never {
  if (code === "not_found") throw createError({ statusCode: 404, message: "Document not found" });
  throw createError({ statusCode: 500, message: "Document markdown is unavailable" });
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
