/** Route core for authenticated AI draft preview/accept/reject over Work-scoped draft documents. */
import type {
  DraftAcceptResponse,
  DraftJournalResponse,
  DraftPreviewResponse,
  DraftRejectResponse,
  DraftReviewSurface,
  DraftUndoResponse,
  ThreadDraftListItem,
  ThreadDraftListResponse,
} from "@meridian/contracts/drafts";
import type { DocumentId, ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import { requireThreadOwner } from "../domains/threads/index.js";
import type { AppServices } from "./app.js";

type DraftRouteServices = {
  threads: Pick<AppServices["threadRepos"]["threads"], "findById">;
  threadWorks: Pick<AppServices["threadRepos"]["threadWorks"], "findPrimary">;
  projects: Pick<AppServices["projectRepo"], "findById">;
  works: Pick<AppServices["workRepo"], "findById">;
  documentAccess: Pick<
    AppServices["documentAccess"],
    "canAccessDocument" | "canAccessProjectDocument"
  >;
  documentSync: Pick<AppServices["documentSync"], "readAsMarkdown"> & {
    drafts: Pick<
      AppServices["documentSync"]["drafts"],
      | "getActiveDraft"
      | "getActiveDraftByWork"
      | "resolveDraftThreadId"
      | "previewDraft"
      | "acceptDraft"
      | "rejectDraft"
      | "undoAcceptDraft"
      | "undoRejectDraft"
      | "listReviewableDrafts"
      | "listReviewableDraftsByWork"
      | "getDraftJournal"
    >;
  };
};

export function selectDraftRouteServices(app: AppServices): DraftRouteServices {
  return {
    threads: app.threadRepos.threads,
    threadWorks: app.threadRepos.threadWorks,
    projects: app.projectRepo,
    works: app.workRepo,
    documentAccess: app.documentAccess,
    documentSync: app.documentSync,
  };
}

export async function requireDraftDocumentAccess(
  deps: DraftRouteServices,
  input: { threadId: ThreadId; documentId: DocumentId; userId: UserId },
): Promise<void> {
  const thread = await requireThreadOwner(
    { threads: deps.threads, projects: deps.projects },
    input.threadId,
    input.userId,
  );
  // Draft routes are thread-scoped, while draft rows are work-scoped through the thread's primary Work.
  // We verify the user owns the document and it belongs to the project —
  // thread_documents attachment is NOT required because project documents
  // are accessible through the context port without explicit thread attachment.
  const [hasDocumentAccess, isProjectDocument] = await Promise.all([
    deps.documentAccess.canAccessDocument(input.userId, input.documentId),
    deps.documentAccess.canAccessProjectDocument(input.userId, input.documentId, thread.projectId),
  ]);
  if (!hasDocumentAccess || !isProjectDocument) {
    throw createError({ statusCode: 404, message: "Draft not found" });
  }
  await requireDraftRouteWork(deps, input.threadId);
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

async function resolveDraftThreadId(deps: DraftRouteServices, draftId: string): Promise<ThreadId> {
  const threadId = await deps.documentSync.drafts.resolveDraftThreadId(draftId);
  if (!threadId) throw createError({ statusCode: 404, message: "Draft not found" });
  return threadId;
}

async function requireDraftRouteWork(
  deps: Pick<DraftRouteServices, "threadWorks">,
  threadId: ThreadId,
): Promise<void> {
  const primaryWork = await deps.threadWorks.findPrimary(threadId);
  if (!primaryWork) throw createError({ statusCode: 404, message: "Draft not found" });
}

export async function handleDraftPreviewRequest(
  deps: DraftRouteServices,
  input: {
    threadId: ThreadId;
    documentId: DocumentId;
    draftId?: string;
    userId: UserId;
    surface?: DraftReviewSurface;
  },
): Promise<DraftPreviewResponse> {
  await requireDraftDocumentAccess(deps, input);
  const live = await deps.documentSync.readAsMarkdown(input.documentId);
  if (!live.ok) throwReadFailure(live.error.code);

  const draft = await deps.documentSync.drafts.getActiveDraft(input);
  if (!draft) return { status: "gone", live: live.value };
  if (input.draftId && draft.id !== input.draftId) return { status: "gone", live: live.value };

  const preview = await deps.documentSync.drafts.previewDraft({
    documentId: input.documentId,
    draftId: draft.id,
    surface: input.surface,
  });

  const base = {
    status: "active" as const,
    draftId: draft.id,
    live: preview.live,
    preview: preview.markdown,
    liveRevisionToken: preview.liveRevisionToken,
    draftRevisionToken: preview.draftRevisionToken,
    recommendedSurface: preview.recommendedSurface,
    ...(preview.fallbackReason ? { fallbackReason: preview.fallbackReason } : {}),
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

export async function handleDraftJournalRequest(
  deps: DraftRouteServices,
  input: {
    threadId: ThreadId;
    documentId: DocumentId;
    draftId: string;
    revisionToken: number;
    userId: UserId;
  },
): Promise<DraftJournalResponse> {
  await requireDraftDocumentAccess(deps, input);
  const activeDraft = await deps.documentSync.drafts.getActiveDraft({
    documentId: input.documentId,
    threadId: input.threadId,
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

export async function handleThreadDraftListRequest(
  deps: DraftRouteServices,
  input: { threadId: ThreadId; userId: UserId },
): Promise<ThreadDraftListResponse> {
  const thread = await requireThreadOwner(
    { threads: deps.threads, projects: deps.projects },
    input.threadId,
    input.userId,
  );
  await requireDraftRouteWork(deps, input.threadId);
  const drafts = await deps.documentSync.drafts.listReviewableDrafts({ threadId: input.threadId });
  const visibleDrafts = await filterAccessibleThreadDrafts(deps, {
    drafts,
    projectId: thread.projectId,
    userId: input.userId,
  });
  return { drafts: visibleDrafts.map(serializeThreadDraft) };
}

export async function handleWorkDraftListRequest(
  deps: DraftRouteServices,
  input: { projectId: ProjectId; workId: WorkId; userId: UserId },
): Promise<ThreadDraftListResponse> {
  await requireDraftWorkAccess(deps, input);
  const drafts = await deps.documentSync.drafts.listReviewableDraftsByWork({
    workId: input.workId,
  });
  const visibleDrafts = await filterAccessibleThreadDrafts(deps, {
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
    surface?: DraftReviewSurface;
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
    surface: input.surface,
  });

  const base = {
    status: "active" as const,
    draftId: draft.id,
    live: preview.live,
    preview: preview.markdown,
    liveRevisionToken: preview.liveRevisionToken,
    draftRevisionToken: preview.draftRevisionToken,
    recommendedSurface: preview.recommendedSurface,
    ...(preview.fallbackReason ? { fallbackReason: preview.fallbackReason } : {}),
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
  await requireDraftWorkAccess(deps, input);
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

export async function handleDraftAcceptRequest(
  deps: DraftRouteServices,
  input: {
    threadId: ThreadId;
    documentId: DocumentId;
    draftId: string;
    userId: UserId;
    confirmOverlap?: boolean;
    confirmedLiveRevisionToken?: number;
    draftRevisionToken: number;
    operationIds?: string[];
  },
): Promise<DraftAcceptResponse> {
  await requireDraftDocumentAccess(deps, input);
  const result = await deps.documentSync.drafts.acceptDraft(input);
  if (
    result.status === "applied" ||
    result.status === "partial_applied" ||
    result.status === "overlap" ||
    result.status === "stale_draft"
  )
    return result;
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

export async function handleDraftRejectRequest(
  deps: DraftRouteServices,
  input: { threadId: ThreadId; documentId: DocumentId; draftId: string; userId: UserId },
): Promise<DraftRejectResponse> {
  await requireDraftDocumentAccess(deps, input);
  const result = await deps.documentSync.drafts.rejectDraft(input);
  if (result.status === "discarded") return result;
  throw createError({ statusCode: 404, message: "Draft not found" });
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
  },
): Promise<DraftAcceptResponse> {
  await requireDraftWorkAccess(deps, input);
  const threadId = await resolveDraftThreadId(deps, input.draftId);
  return handleDraftAcceptRequest(deps, { ...input, threadId });
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
  await requireDraftWorkAccess(deps, input);
  const threadId = await resolveDraftThreadId(deps, input.draftId);
  return handleDraftRejectRequest(deps, { ...input, threadId });
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
  const threadId = await resolveDraftThreadId(deps, input.draftId);
  return handleDraftUndoAcceptRequest(deps, { ...input, threadId });
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
  const threadId = await resolveDraftThreadId(deps, input.draftId);
  return handleDraftUndoRejectRequest(deps, { ...input, threadId });
}

export async function handleDraftUndoAcceptRequest(
  deps: DraftRouteServices,
  input: {
    threadId: ThreadId;
    documentId: DocumentId;
    draftId: string;
    userId: UserId;
    writeId?: string;
  },
): Promise<DraftUndoResponse> {
  await requireDraftDocumentAccess(deps, input);
  const result = await deps.documentSync.drafts.undoAcceptDraft({
    documentId: input.documentId,
    threadId: input.threadId,
    draftId: input.draftId,
    userId: input.userId,
    writeId: input.writeId,
  });
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

export async function handleDraftUndoRejectRequest(
  deps: DraftRouteServices,
  input: {
    threadId: ThreadId;
    documentId: DocumentId;
    draftId: string;
    userId: UserId;
    writeId?: string;
  },
): Promise<DraftUndoResponse> {
  await requireDraftDocumentAccess(deps, input);
  const result = await deps.documentSync.drafts.undoRejectDraft({
    documentId: input.documentId,
    threadId: input.threadId,
    draftId: input.draftId,
  });
  if (result.status === "reactivated") return result;
  if (result.status === "expired") {
    throw createError({ statusCode: 410, message: "Draft discard can no longer be undone" });
  }
  if (result.status === "conflict") {
    throw createError({
      statusCode: 409,
      message: "Another active draft exists for this document",
    });
  }
  throw createError({ statusCode: 404, message: "Draft not found" });
}

async function filterAccessibleThreadDrafts<T extends { documentId: DocumentId }>(
  deps: DraftRouteServices,
  input: {
    drafts: T[];
    projectId: ProjectId;
    userId: UserId;
  },
): Promise<T[]> {
  // Drafts are work-scoped (listReviewableDrafts resolves threadId to the primary Work).
  // We verify document ownership + project membership. Thread-document
  // attachment (thread_documents row) is NOT required — project documents
  // reachable through the context port may have no thread_documents row,
  // but the AI can still create drafts against them.
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
