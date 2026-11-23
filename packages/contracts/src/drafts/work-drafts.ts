import type { CommandId, DraftId, ThreadId, WorkId } from "../ids.js";

/**
 * One of a Work's drafts (a Work has several, one of them its default: what a new chat of the
 * Work writes into). A deleted draft is in no list.
 */
export type WorkDraft = {
  id: DraftId;
  workId: WorkId;
  /** The writer's name for it; null shows the default name. */
  name: string | null;
  isDefault: boolean;
  /** Documents and folders it changes, as the server stores them. */
  pendingDocumentCount: number;
  pendingFolderCount: number;
  createdAt: string;
};

/** GET /api/works/:workId/drafts. */
export type WorkDraftsResponse = { drafts: WorkDraft[] };

/** POST /api/works/:workId/drafts: `+ New draft`. The client may mint the id, to write into it at once. */
export type CreateDraftRequest = { commandId: CommandId; draftId?: DraftId; name?: string | null };

/** PATCH /api/works/:workId/drafts/:draftId: rename. */
export type RenameDraftRequest = { commandId: CommandId; name: string | null };

/**
 * DELETE /api/works/:workId/drafts/:draftId (`Delete draft`), and POST …/restore, its Undo. A
 * deleted draft is kept, untouched and listed nowhere, until retention purges it 30 days on; its
 * chats write into the Work's default meanwhile. Deleting the default makes another draft (or a
 * new empty one) the default; its Undo brings it back as one of the Work's drafts.
 */
export type DeleteDraftRequest = { commandId: CommandId };
export type RestoreDraftRequest = { commandId: CommandId };

/** What a draft command answers: the draft as it stands, null for a delete. */
export type DraftCommandResult = { status: "done"; draft: WorkDraft | null };

/**
 * PUT /api/threads/:threadId/draft: the chat (its lineage) writes into another of its Work's
 * drafts. A draft that is not the Work's, or is deleted, changes nothing (`draftId` answers what
 * the chat writes into).
 */
export type SetChatDraftRequest = { commandId: CommandId; draftId: DraftId };
export type SetChatDraftResult = { status: "done"; threadId: ThreadId; draftId: DraftId };
