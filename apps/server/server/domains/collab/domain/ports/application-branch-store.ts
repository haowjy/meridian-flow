/** Branch capabilities consumed by collab application services. */
import type { DraftId } from "@meridian/contracts";
import type { DocumentId, ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type * as Y from "yjs";
import type { BranchSnapshot, BranchStore } from "../branch-coordinator.js";
import type { BranchResolver, BranchState } from "../branch-resolver.js";

export type ApplicationBranchStore = BranchStore &
  BranchResolver & {
    appendJournal(
      input: import("../branch-coordinator.js").AppendBranchJournalInput,
    ): Promise<void>;
    listActiveWorkDraftBranchIds(documentId: DocumentId): Promise<string[]>;
    ensureWorkDraftBranch(input: {
      documentId: DocumentId;
      workId: WorkId;
      liveDoc: Y.Doc;
    }): Promise<BranchSnapshot>;
    /** The Work's draft branch on a draft's new document, from its durable live state, in the caller's transaction. */
    ensureCreatedDraftBranch(input: { documentId: DocumentId; workId: WorkId }): Promise<void>;
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
    }): Promise<{ documentId: DocumentId; members: string[] }>;
    reconcileProjectManifest(projectId: ProjectId): Promise<void>;
    transferLiveManifestMembership(
      documentIds: readonly DocumentId[],
      projects: { from: ProjectId; to: ProjectId },
    ): Promise<void>;
    recordManifestDocumentCreated(
      documentId: DocumentId,
      view?: { projectId: ProjectId },
    ): Promise<void>;
    recordManifestDocumentDeleted(
      documentId: DocumentId,
      view?: { projectId: ProjectId },
    ): Promise<void>;
  };

/**
 * Discards one Work draft without applying content to live; a document the Work's draft
 * created ends that draft's use (bridge until lane D's `discardItems`).
 */
export type WorkDraftDiscard = (input: {
  createdBy?: DraftId;
  workId: WorkId;
  documentId: DocumentId;
  contentBranchId: string;
}) => Promise<void>;
