import type { DraftId, ThreadId, WorkId } from "../ids.js";

export type WorkDraft = {
  id: DraftId;
  workId: WorkId;
  name: string | null;
  isDefault: boolean;
  pendingDocumentCount: number;
  pendingFolderCount: number;
  createdAt: string;
};

export type WorkDraftsResponse = { drafts: WorkDraft[] };

export type DraftCommandResult = { status: "done"; draft: WorkDraft | null };

export type SetChatDraftResult = { status: "done"; threadId: ThreadId; draftId: DraftId };
