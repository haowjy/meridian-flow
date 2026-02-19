import Dexie, { Table } from "dexie";
import { Document } from "@/features/documents/types/document";
import { Thread, Turn } from "@/features/threads/types";
import type {
  PendingDocumentSave,
  PendingTreeOp,
  ProjectTreeCache,
} from "@/core/lib/offlineTypes";

export class MeridianDB extends Dexie {
  documents!: Table<Document & { content: string }, string>;
  threads!: Table<Thread, string>;
  messages!: Table<Turn, string>;
  projectTrees!: Table<ProjectTreeCache, string>;
  pendingDocumentSaves!: Table<PendingDocumentSave, string>;
  pendingTreeOps!: Table<PendingTreeOp, number>;

  constructor() {
    super("meridian");

    // Version 1: Initial schema (documents + syncQueue)
    this.version(1).stores({
      documents: "id, projectId, folderId, updatedAt",
      syncQueue: "++id, documentId, createdAt",
    });

    // Version 2: Add threads and messages, upgrade syncQueue
    this.version(2).stores({
      documents: "id, projectId, folderId, updatedAt",
      threads: "id, projectId, createdAt",
      messages: "id, threadId, createdAt",
      syncQueue: "++id, entityType, entityId, timestamp, retryCount",
    });

    // Version 3: Remove syncQueue (moved to in-memory retry system)
    this.version(3).stores({
      documents: "id, projectId, folderId, updatedAt",
      threads: "id, projectId, createdAt",
      messages: "id, threadId, createdAt",
      syncQueue: null, // Delete the table
    });

    // Version 4: Add lastAccessedAt to messages for future eviction
    this.version(4).stores({
      documents: "id, projectId, folderId, updatedAt",
      threads: "id, projectId, createdAt",
      messages: "id, threadId, createdAt, lastAccessedAt",
    });

    // Version 5: Add offline-first tree cache + pending operation tables
    this.version(5).stores({
      documents: "id, projectId, folderId, updatedAt",
      threads: "id, projectId, createdAt",
      messages: "id, threadId, createdAt, lastAccessedAt",
      projectTrees: "projectId",
      pendingDocumentSaves: "documentId",
      pendingTreeOps: "++id, projectId, [projectId+status]",
    });
  }
}

export const db = new MeridianDB();
