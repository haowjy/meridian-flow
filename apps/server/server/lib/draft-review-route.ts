/** Route core for authenticated AI draft preview/accept/reject over thread-scoped documents. */
import type {
  DraftAcceptResponse,
  DraftPreviewResponse,
  DraftRejectResponse,
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
  documentSync: AppServices["documentSync"];
};

export function selectDraftRouteServices(app: AppServices): DraftRouteServices {
  return {
    threads: app.threadRepos.threads,
    projects: app.projectRepo,
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
  // Drafts are already thread-scoped in document_yjs_drafts (threadId FK).
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
}

export async function handleDraftPreviewRequest(
  deps: DraftRouteServices,
  input: { threadId: ThreadId; documentId: DocumentId; draftId?: string; userId: UserId },
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
  });

  return {
    status: "active",
    draftId: draft.id,
    live: preview.live,
    preview: preview.markdown,
    liveRevisionToken: preview.liveRevisionToken,
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
    userId: input.userId,
  });
  return { drafts: visibleDrafts.map(serializeThreadDraft) };
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
  },
): Promise<DraftAcceptResponse> {
  await requireDraftDocumentAccess(deps, input);
  const result = await deps.documentSync.drafts.acceptDraft(input);
  if (result.status === "applied" || result.status === "overlap") return result;
  if (result.status === "in_progress") {
    throw createError({ statusCode: 409, message: "Draft accept already in progress" });
  }
  if (result.status === "discarded") {
    throw createError({ statusCode: 410, message: "Draft is no longer active" });
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

async function filterAccessibleThreadDrafts<T extends { documentId: DocumentId }>(
  deps: DraftRouteServices,
  input: {
    drafts: T[];
    projectId: ProjectId;
    userId: UserId;
  },
): Promise<T[]> {
  // Drafts are already thread-scoped (listActiveDrafts filters by threadId).
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
