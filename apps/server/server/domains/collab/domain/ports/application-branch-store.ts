/** Branch capabilities consumed by collab application services. */
import type { DocumentId, ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type * as Y from "yjs";
import type { BranchSnapshot, BranchStore } from "../branch-coordinator.js";
import type { BranchResolver, BranchState } from "../branch-resolver.js";

export type ManifestMutationResult = {
  workDraftBranchId?: string;
  policy?: "manual" | "auto";
};

export type ApplicationBranchStore = BranchStore &
  BranchResolver & {
    listActiveWorkDraftBranchIds(documentId: DocumentId): Promise<string[]>;
    ensureWorkDraftBranch(input: {
      documentId: DocumentId;
      workId: WorkId;
      liveDoc: Y.Doc;
    }): Promise<BranchSnapshot>;
    ensureThreadPeerBranch(input: {
      documentId: DocumentId;
      threadId: ThreadId;
      liveDoc: Y.Doc;
    }): Promise<BranchSnapshot>;
    discardActiveThreadPeerBranches(input: {
      documentId: DocumentId;
      threadId?: ThreadId | null;
    }): Promise<void>;
    resolveWorkDraftBranchForThread(
      documentId: DocumentId,
      threadId: ThreadId,
    ): Promise<BranchState>;
    resolveWorkDraftBranchForWork(input: {
      documentId: DocumentId;
      workId: WorkId;
      liveDoc: Y.Doc;
    }): Promise<BranchState>;
    ensureProjectManifest(input: { projectId: ProjectId; contextSourceId?: string }): Promise<{
      documentId: DocumentId;
      doc: Y.Doc;
    }>;
    resolveManifestMembership(input: {
      projectId: ProjectId;
      workId?: WorkId | null;
      threadId?: ThreadId | null;
    }): Promise<{ documentId: DocumentId; members: string[] }>;
    reconcileProjectManifest(projectId: ProjectId): Promise<void>;
    recordManifestDocumentCreated(
      documentId: DocumentId,
      view?: { projectId: ProjectId; workId?: WorkId | null; threadId?: ThreadId | null },
    ): Promise<ManifestMutationResult>;
    recordManifestDocumentDeleted(
      documentId: DocumentId,
      view?: { projectId: ProjectId; workId?: WorkId | null; threadId?: ThreadId | null },
    ): Promise<ManifestMutationResult>;
  };
