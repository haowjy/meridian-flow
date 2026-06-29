/** Route core for authenticated AI draft preview/accept/reject over thread-scoped documents. */
import type {
  DraftAcceptResponse,
  DraftPreviewResponse,
  DraftRejectResponse,
  DraftReviewSummary,
  ThreadDraftListItem,
  ThreadDraftListResponse,
} from "@meridian/contracts/drafts";
import type { DocumentId, ProjectId, ThreadId, UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import { requireThreadOwner } from "../domains/threads/index.js";
import type { AppServices } from "./app.js";

type DraftRouteServices = {
  threads: AppServices["threadRepos"]["threads"];
  projects: AppServices["projectRepo"];
  documentAccess: AppServices["documentAccess"];
  uploadDocuments: AppServices["uploadDocuments"];
  documentSync: AppServices["documentSync"];
};

export function selectDraftRouteServices(app: AppServices): DraftRouteServices {
  return {
    threads: app.threadRepos.threads,
    projects: app.projectRepo,
    documentAccess: app.documentAccess,
    uploadDocuments: app.uploadDocuments,
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
  const [hasDocumentAccess, isProjectDocument, threadDocument] = await Promise.all([
    deps.documentAccess.canAccessDocument(input.userId, input.documentId),
    deps.documentAccess.canAccessProjectDocument(input.userId, input.documentId, thread.projectId),
    deps.uploadDocuments.getUpload(input.threadId, input.documentId),
  ]);
  if (!hasDocumentAccess || !isProjectDocument || !threadDocument) {
    throw createError({ statusCode: 404, message: "Draft not found" });
  }
}

export async function handleDraftPreviewRequest(
  deps: DraftRouteServices,
  input: { threadId: ThreadId; documentId: DocumentId; userId: UserId },
): Promise<DraftPreviewResponse> {
  await requireDraftDocumentAccess(deps, input);
  const live = await deps.documentSync.readAsMarkdown(input.documentId);
  if (!live.ok) throwReadFailure(live.error.code);

  const draft = await deps.documentSync.drafts.getActiveDraft(input);
  if (!draft) return { draft: null, live: live.value };

  return {
    draft: serializeDraft(draft),
    live: live.value,
    preview: await deps.documentSync.drafts.previewMarkdown({
      documentId: input.documentId,
      draftId: draft.id,
    }),
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
  const drafts = await deps.documentSync.drafts.listActiveDrafts({ threadId: input.threadId });
  const visibleDrafts = await filterAccessibleThreadDrafts(deps, {
    drafts,
    projectId: thread.projectId,
    threadId: input.threadId,
    userId: input.userId,
  });
  return { drafts: visibleDrafts.map(serializeThreadDraft) };
}

export async function handleDraftAcceptRequest(
  deps: DraftRouteServices,
  input: { threadId: ThreadId; documentId: DocumentId; userId: UserId },
): Promise<DraftAcceptResponse> {
  await requireDraftDocumentAccess(deps, input);
  const result = await deps.documentSync.drafts.acceptDraft(input);
  if (result.status === "applied") return result;
  if (result.status === "discarded")
    return { ...result, appliedUpdateSeq: null, acceptTurnId: null };
  if (result.status === "in_progress")
    return { ...result, appliedUpdateSeq: null, acceptTurnId: null };
  return { status: "not_found", draftId: null, appliedUpdateSeq: null, acceptTurnId: null };
}

export async function handleDraftRejectRequest(
  deps: DraftRouteServices,
  input: { threadId: ThreadId; documentId: DocumentId; userId: UserId },
): Promise<DraftRejectResponse> {
  await requireDraftDocumentAccess(deps, input);
  const result = await deps.documentSync.drafts.rejectDraft(input);
  return result.status === "discarded" ? result : { status: "not_found", draftId: null };
}

async function filterAccessibleThreadDrafts<T extends { documentId: DocumentId }>(
  deps: DraftRouteServices,
  input: {
    drafts: T[];
    projectId: ProjectId;
    threadId: ThreadId;
    userId: UserId;
  },
): Promise<T[]> {
  const checks: Array<T | null> = await Promise.all(
    input.drafts.map(async (draft): Promise<T | null> => {
      const [hasDocumentAccess, isProjectDocument, threadDocument] = await Promise.all([
        deps.documentAccess.canAccessDocument(input.userId, draft.documentId),
        deps.documentAccess.canAccessProjectDocument(
          input.userId,
          draft.documentId,
          input.projectId,
        ),
        deps.uploadDocuments.getUpload(input.threadId, draft.documentId),
      ]);
      return hasDocumentAccess && isProjectDocument && threadDocument ? draft : null;
    }),
  );
  return checks.filter((draft): draft is T => draft !== null);
}

function serializeDraft(draft: {
  id: string;
  status: DraftReviewSummary["status"];
  lastActorTurnId: string | null;
  updatedAt: Date;
}): DraftReviewSummary {
  return {
    id: draft.id,
    status: draft.status,
    lastActorTurnId: draft.lastActorTurnId,
    updatedAt: draft.updatedAt.toISOString(),
  };
}

function serializeThreadDraft(draft: {
  id: string;
  documentId: string;
  documentName: string | null;
  status: "active";
  lastActorTurnId: string | null;
  updatedAt: Date;
}): ThreadDraftListItem {
  return {
    draftId: draft.id,
    documentId: draft.documentId,
    documentName: draft.documentName,
    status: draft.status,
    lastActorTurnId: draft.lastActorTurnId,
    updatedAt: draft.updatedAt.toISOString(),
  };
}

function throwReadFailure(code: string): never {
  if (code === "not_found") throw createError({ statusCode: 404, message: "Document not found" });
  throw createError({ statusCode: 500, message: "Document markdown is unavailable" });
}
