/** Work-draft listing, repair, preview, Apply, and Discard orchestration. */
import type { YProsemirrorDocumentModel } from "@meridian/agent-edit/integration";
import type { DraftId } from "@meridian/contracts";
import { branchRoomName } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId, UserId, WorkId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { CollabDrafts } from "../contracts.js";
import type { ThreadPeerAgentEditCore } from "./agent-edit-cores.js";
import type { BranchCoordinator } from "./branch-coordinator.js";
import type {
  BranchJournalReadStore,
  BranchPushService,
  BranchReviewService,
} from "./branch-push-contracts.js";
import { BranchCorruptError } from "./branch-resolver.js";
import type { ReviewableDraft } from "./branch-review.js";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import type { MarkdownDocumentEngine } from "./markdown-document.js";
import type { ApplicationBranchStore, WorkDraftDiscard } from "./ports/application-branch-store.js";
import { type DocumentLinkScopes, LIVE_VIEW } from "./ports/document-link-scope.js";
import { documentTitleFromUri } from "./reversal-notices.js";
import type { WorkDraftPending } from "./work-draft-pending.js";

/** The review service's view of a draft's tree, until lanes E and D replace the bridges. */
export interface DraftTreeReviewBridge {
  /** Documents the Work's active draft created that are still hidden. */
  createdHidden(workId: WorkId): Promise<ReadonlySet<DocumentId>>;
  activeDraftId(workId: WorkId): Promise<DraftId | null>;
  /** Reveal a created document at the draft's location, in its own transaction. */
  revealCreated(input: { workId: WorkId; documentId: DocumentId }): Promise<void>;
}

export function createWorkDraftReviewService(input: {
  /** Both sides of a preview spell from one snapshot: live in the live view, the draft in its own. */
  links: DocumentLinkScopes;
  branches: ApplicationBranchStore;
  discardWorkDraft: WorkDraftDiscard;
  branchCoordinator: BranchCoordinator;
  branchJournal: BranchJournalReadStore;
  branchPush: BranchPushService;
  branchReview: BranchReviewService;
  workDraftPending: WorkDraftPending;
  liveCoordinator: {
    withDocument<T>(documentId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T>;
  };
  documents: Pick<MarkdownDocumentEngine, "serializeDocument">;
  model: YProsemirrorDocumentModel;
  agentEdit: ThreadPeerAgentEditCore;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  latestUpdateSeq(documentId: string): Promise<number>;
  draftTree: DraftTreeReviewBridge;
}): CollabDrafts {
  /** Documents the Work's active draft created that are still hidden: "new" in review. */
  async function createdDocumentIds(workId: WorkId): Promise<ReadonlySet<DocumentId>> {
    return input.draftTree.createdHidden(workId);
  }

  async function listReviewableWorkDraftBranches(
    workId: WorkId,
    _projectId?: ProjectId,
  ): Promise<ReviewableDraft[]> {
    const draftOnlyDocumentIds = await createdDocumentIds(workId);
    const drafts: ReviewableDraft[] = [];
    for (const { branch, rows } of await input.workDraftPending.list(workId)) {
      const uri = await input.resolveDocumentUri(branch.documentId);
      drafts.push({
        draftId: branch.branchId,
        documentId: branch.documentId,
        workId,
        status: "active",
        lastActorTurnId: rows.find((row) => row.turnId)?.turnId ?? null,
        wordsAdded: null,
        wordsRemoved: null,
        updatedAt: new Date(),
        documentName: documentTitleFromUri(uri),
        contextPath: manuscriptContextPath(uri),
        ...(draftOnlyDocumentIds.has(branch.documentId) ? { createdDocument: true } : {}),
      });
    }
    return drafts;
  }

  async function isCreatedDocument(command: {
    workId: WorkId;
    documentId: DocumentId;
  }): Promise<boolean> {
    return (await createdDocumentIds(command.workId)).has(command.documentId);
  }

  async function previewWorkDraftBranch(command: {
    projectId?: ProjectId;
    documentId: DocumentId;
    workId: WorkId;
    draftId: string;
  }) {
    return input.links.within({ documentId: command.documentId }, async () => {
      const liveState = await input.liveCoordinator.withDocument(
        command.documentId,
        async (liveDoc) => ({
          state: Y.encodeStateAsUpdate(liveDoc),
          markdown: await input.documents.serializeDocument(command.documentId, liveDoc, LIVE_VIEW),
        }),
      );
      const liveDoc = createCollabYDoc({ gc: false });
      Y.applyUpdate(liveDoc, liveState.state);
      let notice: { code: "branch_corrupt_reset"; message: string } | undefined;
      try {
        let branch: { branchId: string; generation: number; doc: Y.Doc };
        try {
          branch = await input.branches.resolveWorkDraftBranchForWork({
            documentId: command.documentId,
            workId: command.workId,
            liveDoc,
          });
        } catch (cause) {
          if (!(cause instanceof BranchCorruptError)) throw cause;
          const corrupt = await input.branches.getBranch(cause.branchId);
          if (corrupt?.kind !== "work_draft" || corrupt.status !== "active") throw cause;
          await input.branchCoordinator.resetFromDoc(corrupt.branchId, liveDoc);
          await input.agentEdit.invalidateThread(command.documentId, "");
          notice = {
            code: "branch_corrupt_reset",
            message: "Review state was repaired from the live document.",
          };
          branch = await input.branches.resolveWorkDraftBranchForWork({
            documentId: command.documentId,
            workId: command.workId,
            liveDoc,
          });
        }
        if (branch.branchId !== command.draftId) throw new Error("draft_not_found");
        try {
          const draftUpdates = (
            await input.branchJournal.listReviewableJournalRows(branch.branchId, branch.generation)
          ).map((row) => ({
            id: row.id,
            actorTurnId: row.turnId,
            actorUserId: row.actorUserId,
            updateData: row.updateData,
            updateKind: row.status === "rollback_pending" ? "rollback_pending" : row.source,
          }));
          const review = computeDraftReviewHunks({
            liveDoc,
            draftDoc: branch.doc,
            model: input.model,
            draftUpdates,
          });
          return {
            status: "active" as const,
            draftId: command.draftId,
            reviewRoomName: branchRoomName(branch.branchId, branch.generation),
            live: liveState.markdown,
            markdown: await input.documents.serializeDocument(command.documentId, branch.doc, {
              kind: "draft",
              workId: command.workId,
            }),
            isNewDocument: await isCreatedDocument(command),
            liveRevisionToken: await input.latestUpdateSeq(command.documentId),
            draftRevisionToken: branch.generation,
            inlineModelPresent: true as const,
            operations: review.operations,
            hunks: review.hunks,
            ...(notice ? { notice } : {}),
          };
        } finally {
          branch.doc.destroy();
        }
      } finally {
        liveDoc.destroy();
      }
    });
  }

  async function resolveActiveWorkDraft(command: {
    draftId: string;
    documentId: DocumentId;
    workId: WorkId;
  }) {
    const branch = await input.branches.getBranch(command.draftId);
    return branch?.kind === "work_draft" &&
      branch.status === "active" &&
      branch.workId === command.workId &&
      branch.documentId === command.documentId
      ? branch
      : null;
  }

  async function applyWorkDraft(command: {
    projectId?: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    draftId: string;
    userId: UserId;
    signal?: AbortSignal;
  }) {
    const branch = await resolveActiveWorkDraft(command);
    if (!branch) return { status: "not_found" as const, draftId: command.draftId };

    // Bridge until lane E's one publication: a created document is revealed at the
    // draft's location in its own transaction, then its text is pushed.
    if (await isCreatedDocument(command)) {
      await input.draftTree.revealCreated({
        workId: command.workId,
        documentId: command.documentId,
      });
    }
    await input.branchPush.pushToLive({
      branchId: branch.branchId,
      pushedByUserId: command.userId,
      signal: command.signal,
    });
    return { status: "applied" as const, draftId: command.draftId };
  }

  async function discardWorkDraft(command: {
    projectId?: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    draftId: string;
    userId?: UserId;
    threadId?: string;
    operationIds?: string[];
  }) {
    const _projectId = command.projectId;
    const branch = await resolveActiveWorkDraft(command);
    if (!branch) return { status: "discarded" as const, draftId: command.draftId };

    if (command.operationIds && command.operationIds.length > 0) {
      const preview = await previewWorkDraftBranch(command);
      const requestedClassIds = new Set(
        preview.operations
          .filter((operation) => command.operationIds?.includes(operation.operationId))
          .map((operation) => operation.closureClassId),
      );
      const updateIds = new Set<number>();
      for (const operation of preview.operations) {
        if (!requestedClassIds.has(operation.closureClassId)) continue;
        for (const id of operation.discardUpdateIds) updateIds.add(id);
      }
      await input.branchReview.discardSelected({
        branchId: branch.branchId,
        journalIds: [...updateIds],
        reviewedByUserId: command.userId,
      });
    } else {
      // Bridge until lane D's discardItems: a created document ends the draft's use.
      const createdBy = (await isCreatedDocument(command))
        ? await input.draftTree.activeDraftId(command.workId)
        : null;
      await input.discardWorkDraft({
        ...(createdBy ? { createdBy } : {}),
        workId: command.workId,
        documentId: command.documentId,
        contentBranchId: branch.branchId,
      });
      await input.agentEdit.invalidateThread(command.documentId, command.threadId ?? "");
    }
    return { status: "discarded" as const, draftId: command.draftId };
  }

  return {
    draftReview: {
      async list(command) {
        return listReviewableWorkDraftBranches(command.workId, command.projectId);
      },
      async preview(command) {
        return previewWorkDraftBranch(command);
      },
      async applyWorkDraft(command) {
        return applyWorkDraft(command);
      },
      async discardWorkDraft(command) {
        return discardWorkDraft(command);
      },
    },
    draftSessionStats: {
      async listActiveDraftsByWork(command) {
        return listReviewableWorkDraftBranches(command.workId);
      },
    },
  };
}

function manuscriptContextPath(uri: string | null): string | null {
  if (!uri?.startsWith("manuscript://")) return null;
  const path = uri.slice("manuscript://".length).replace(/^\/+/, "");
  return path ? `/${path}` : null;
}
