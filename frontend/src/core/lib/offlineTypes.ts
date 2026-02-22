import type { Document } from "@/features/documents/types/document";
import type { Folder } from "@/features/folders/types/folder";

export type CachedFolder = Folder;
export type CachedDocumentMeta = Omit<Document, "content"> & {
  content?: undefined;
};

// Tree cache
export interface ProjectTreeCache {
  projectId: string;
  folders: CachedFolder[];
  documents: CachedDocumentMeta[];
  updatedAt: string; // ISO timestamp of when cache was written
}

// Pending document save
export interface PendingDocumentSave {
  documentId: string;
  content: string; // markdown content
  createdAt: string; // ISO timestamp
}

// Pending tree operation
export type TreeOpType = "rename" | "move" | "delete";
export type TreeEntityType = "document" | "folder";
export type TreeOpStatus = "pending" | "done" | "failed";

export type RenameTreeOpParams = { name: string };
export type MoveTreeOpParams = { folderId: string };
export type DeleteTreeOpParams = Record<string, never>;
export type TreeOpParams =
  | RenameTreeOpParams
  | MoveTreeOpParams
  | DeleteTreeOpParams;

export interface PendingTreeOpBase {
  id?: number; // auto-increment, present after persist
  projectId: string;
  entityType: TreeEntityType;
  entityId: string; // UUID of the document or folder
  createdAt: string; // ISO timestamp
  status: TreeOpStatus;
}

export type PendingRenameTreeOp = PendingTreeOpBase & {
  opType: "rename";
  params: RenameTreeOpParams;
};

export type PendingMoveTreeOp = PendingTreeOpBase & {
  opType: "move";
  params: MoveTreeOpParams;
};

export type PendingDeleteTreeOp = PendingTreeOpBase & {
  opType: "delete";
  params: DeleteTreeOpParams;
};

export type PendingTreeOp =
  | PendingRenameTreeOp
  | PendingMoveTreeOp
  | PendingDeleteTreeOp;

// Cached proposal yjsUpdate for instant re-open (avoids server round-trip)
export interface CachedProposalUpdate {
  proposalId: string;
  documentId: string;
  yjsUpdate: string; // base64-encoded
  cachedAt: string; // ISO timestamp
}
