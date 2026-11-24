import type { CommandId, DraftId, ThreadId, WorkId } from "../ids.js";

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

export type CreateDraftRequest = { commandId: CommandId; draftId?: DraftId; name?: string | null };

export type RenameDraftRequest = { commandId: CommandId; name: string | null };

export type DeleteDraftRequest = { commandId: CommandId };
export type RestoreDraftRequest = { commandId: CommandId };

export type DraftCommandResult = { status: "done"; draft: WorkDraft | null };

export type SetChatDraftRequest = { commandId: CommandId; draftId: DraftId };
export type SetChatDraftResult = { status: "done"; threadId: ThreadId; draftId: DraftId };
