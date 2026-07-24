/** Work-draft listing, repair, preview, accept, and reject orchestration. */
import type { YProsemirrorDocumentModel } from "@meridian/agent-edit/integration";
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
  PushToLiveResult,
  WorkPushPolicyStore,
} from "./branch-push-contracts.js";
import { BranchCorruptError } from "./branch-resolver.js";
import type { ReviewableDraft } from "./branch-review.js";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import type { MarkdownDocumentEngine } from "./markdown-document.js";
import type { ApplicationBranchStore } from "./ports/application-branch-store.js";
import { documentTitleFromUri } from "./reversal-notices.js";

export function createWorkDraftReviewService(input: {
  branches: ApplicationBranchStore;
  branchCoordinator: BranchCoordinator;
  branchJournal: BranchJournalReadStore;
  branchPush: BranchPushService;
  branchReview: BranchReviewService;
  workPushPolicy: WorkPushPolicyStore;
  liveCoordinator: {
    withDocument<T>(documentId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T>;
  };
  documents: Pick<MarkdownDocumentEngine, "readAsMarkdown" | "serializeDocument">;
  model: YProsemirrorDocumentModel;
  agentEdit: ThreadPeerAgentEditCore;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  latestUpdateSeq(documentId: string): Promise<number>;
}): CollabDrafts {
  async function resolveDraftOnlyDocumentIds(command: {
    projectId?: ProjectId;
    workId: WorkId;
  }): Promise<Set<DocumentId>> {
    if (!command.projectId) return new Set();
    // Resolve live first: both adapter calls ensure the project manifest,
    // and racing them on a project without one violates its unique identity.
    const liveMembership = await input.branches.resolveManifestMembership({
      projectId: command.projectId,
    });
    const draftMembership = await input.branches.resolveManifestMembership({
      projectId: command.projectId,
      workId: command.workId,
    });
    const liveDocumentIds = new Set(liveMembership.members);
    return new Set(
      draftMembership.members.filter((documentId) => !liveDocumentIds.has(documentId)),
    );
  }

  async function listReviewableWorkDraftBranches(
    workId: WorkId,
    projectId?: ProjectId,
  ): Promise<ReviewableDraft[]> {
    const draftOnlyDocumentIds = await resolveDraftOnlyDocumentIds({ projectId, workId });
    const branchIds = await input.workPushPolicy.listActiveWorkDraftBranchIdsForWork(workId);
    const drafts: ReviewableDraft[] = [];
    for (const branchId of branchIds) {
      const branch = await input.branches.getBranch(branchId);
      if (branch?.kind !== "work_draft" || branch.status !== "active" || branch.workId !== workId) {
        continue;
      }
      const rows = await input.branchJournal.listReviewableJournalRows(
        branch.branchId,
        branch.generation,
      );
      if (rows.length === 0) continue;
      const uri = await input.resolveDocumentUri(branch.documentId);
      drafts.push({
        id: branch.branchId,
        documentId: branch.documentId,
        workId,
        status: "active",
        branchId: branch.branchId,
        generation: branch.generation,
        lastActorTurnId: rows.find((row) => row.turnId)?.turnId ?? null,
        appliedAt: null,
        discardedAt: null,
        undoneAt: null,
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

  async function isDraftOnlyManifestDocument(command: {
    projectId?: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
  }): Promise<boolean> {
    return (await resolveDraftOnlyDocumentIds(command)).has(command.documentId);
  }

  async function previewWorkDraftBranch(command: {
    projectId?: ProjectId;
    documentId: DocumentId;
    workId: WorkId;
  }) {
    const liveState = await input.liveCoordinator.withDocument(
      command.documentId,
      async (liveDoc) => ({
        state: Y.encodeStateAsUpdate(liveDoc),
        markdown: await input.documents.serializeDocument(command.documentId, liveDoc),
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
          partitionClosureClasses: true,
        });
        return {
          status: "active" as const,
          branchId: branch.branchId,
          live: liveState.markdown,
          markdown: await input.documents.serializeDocument(command.documentId, branch.doc),
          isNewDocument: await isDraftOnlyManifestDocument(command),
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
  }

  async function pushNewDocumentToLiveWithManifest(command: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    branchId: string;
    journalIds?: readonly number[];
    userId: UserId;
    signal?: AbortSignal;
  }): Promise<PushToLiveResult> {
    const manifest = await input.branches.ensureProjectManifest({ projectId: command.projectId });
    try {
      const manifestBranch = await input.branches.resolveWorkDraftBranchForWork({
        documentId: manifest.documentId,
        workId: command.workId,
        liveDoc: manifest.doc,
      });
      try {
        return await input.branchPush.pushToLiveWithManifestEntry({
          branchId: command.branchId,
          manifestBranchId: manifestBranch.branchId,
          manifestEntryDocumentId: command.documentId,
          ...(command.journalIds ? { contentJournalIds: command.journalIds } : {}),
          pushedByUserId: command.userId,
          signal: command.signal,
        });
      } finally {
        manifestBranch.doc.destroy();
      }
    } finally {
      manifest.doc.destroy();
    }
  }

  async function removeNewDocumentFromWorkManifest(command: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
  }): Promise<void> {
    const mutation = await input.branches.recordManifestDocumentDeleted(
      command.documentId,
      command,
    );
    if (mutation?.workDraftBranchId) {
      await input.branchPush.pushAutoBranchAfterThreadPeerWrite({
        workDraftBranchId: mutation.workDraftBranchId,
      });
    }
  }

  return {
    draftReview: {
      async list(command) {
        return command.workId
          ? listReviewableWorkDraftBranches(command.workId, command.projectId)
          : [];
      },
      async preview(command) {
        if (command.workId) {
          const branchPreview = await previewWorkDraftBranch({
            projectId: command.projectId,
            documentId: command.documentId,
            workId: command.workId,
          });
          if (branchPreview) return branchPreview;
        }
        const live = await input.documents.readAsMarkdown(command.documentId);
        if (!live.ok) throw new Error(`read_failed:${live.error.code}`);
        return { status: "gone", live: live.value };
      },
      async accept(command) {
        if (command.workId) {
          const branch = command.branchId ? await input.branches.getBranch(command.branchId) : null;
          if (
            branch?.kind === "work_draft" &&
            branch.status === "active" &&
            branch.workId === command.workId &&
            branch.documentId === command.documentId
          ) {
            const selectedOperationIds = command.operationIds;
            if (
              command.draftRevisionToken !== undefined &&
              command.draftRevisionToken !== branch.generation
            ) {
              return {
                status: "stale_draft" as const,
                draftId: branch.branchId,
                draftRevisionToken: branch.generation,
              };
            }
            const preview = await previewWorkDraftBranch({
              projectId: command.projectId,
              documentId: command.documentId,
              workId: command.workId,
            });
            if (preview?.status !== "active") throw new Error("draft_not_found");
            const requested = new Set(selectedOperationIds);
            const operationIds = new Set<string>();
            for (const operation of preview.operations) {
              if (!requested.has(operation.operationId)) continue;
              for (const id of operation.acceptClosureOperationIds ?? [operation.operationId]) {
                operationIds.add(id);
              }
            }
            const updateIds = new Set<number>();
            for (const operation of preview.operations) {
              if (!operationIds.has(operation.operationId)) continue;
              for (const id of operation.directionalClosure.accept.updateIds) updateIds.add(id);
            }
            if (preview.isNewDocument && command.projectId) {
              const pushed = await pushNewDocumentToLiveWithManifest({
                projectId: command.projectId,
                workId: command.workId,
                documentId: command.documentId,
                branchId: branch.branchId,
                journalIds: [...updateIds],
                userId: command.userId,
                signal: command.signal,
              });
              if (pushed.status === "push_concurrent_conflict") {
                return {
                  status: "concurrent_conflict" as const,
                  reason: pushed.reason,
                  conflictedBlocks: pushed.conflictedBlocks,
                  conflicts: pushed.conflicts,
                };
              }
            } else {
              const pushed = await input.branchPush.pushSelectedToLive({
                branchId: branch.branchId,
                journalIds: [...updateIds],
                pushedByUserId: command.userId,
                signal: command.signal,
              });
              if (pushed.status === "push_concurrent_conflict") {
                return {
                  status: "concurrent_conflict" as const,
                  reason: pushed.reason,
                  conflictedBlocks: pushed.conflictedBlocks,
                  conflicts: pushed.conflicts,
                };
              }
            }
            const appliedEveryPreviewedOperation = preview.operations.every((operation) =>
              requested.has(operation.operationId),
            );
            if (appliedEveryPreviewedOperation) {
              return {
                status: "applied" as const,
                draftId: branch.branchId,
                branchId: branch.branchId,
                appliedUpdateSeq: 0,
              };
            }
            return {
              status: "partial_applied" as const,
              draftId: branch.branchId,
              appliedUpdateSeq: 0,
              acceptedOperationIds: [...operationIds].sort(),
              writeId: [...updateIds].sort((left, right) => left - right).join(","),
            };
          }
        }
        return {
          status: "not_found" as const,
          draftId: command.draftId ?? command.branchId ?? "",
        };
      },
      async reject(command) {
        if (command.workId) {
          const branch = command.branchId ? await input.branches.getBranch(command.branchId) : null;
          if (
            branch?.kind === "work_draft" &&
            branch.status === "active" &&
            branch.workId === command.workId &&
            branch.documentId === command.documentId
          ) {
            if (command.operationIds && command.operationIds.length > 0) {
              const preview = await previewWorkDraftBranch({
                projectId: command.projectId,
                documentId: command.documentId,
                workId: command.workId,
              });
              if (preview?.status !== "active") throw new Error("draft_not_found");
              const requested = new Set(command.operationIds);
              const operationIds = new Set<string>();
              for (const operation of preview.operations) {
                if (!requested.has(operation.operationId)) continue;
                for (const id of operation.rejectClosureOperationIds ?? [operation.operationId]) {
                  operationIds.add(id);
                }
              }
              const updateIds = new Set<number>();
              for (const operation of preview.operations) {
                if (!operationIds.has(operation.operationId)) continue;
                for (const id of operation.directionalClosure.reject.updateIds) updateIds.add(id);
              }
              await input.branchReview.discardSelected({
                branchId: branch.branchId,
                journalIds: [...updateIds],
                reviewedByUserId: command.userId,
              });
            } else {
              if (
                command.projectId &&
                (await isDraftOnlyManifestDocument({
                  projectId: command.projectId,
                  workId: command.workId,
                  documentId: command.documentId,
                }))
              ) {
                await removeNewDocumentFromWorkManifest({
                  projectId: command.projectId,
                  workId: command.workId,
                  documentId: command.documentId,
                });
              }
              await input.liveCoordinator.withDocument(command.documentId, async (liveDoc) =>
                input.branchCoordinator.resetFromDoc(branch.branchId, liveDoc),
              );
              await input.agentEdit.invalidateThread(command.documentId, command.threadId ?? "");
            }
            return {
              status: "discarded" as const,
              draftId: branch.branchId,
              branchId: branch.branchId,
            };
          }
        }
        return {
          status: "discarded" as const,
          draftId: command.draftId ?? command.branchId ?? "",
        };
      },
    },
    draftSessionStats: {
      async listActiveDraftsByWork(command) {
        return (await listReviewableWorkDraftBranches(command.workId)).filter(
          (draft): draft is ReviewableDraft & { status: "active" } => draft.status === "active",
        );
      },
    },
  };
}

function manuscriptContextPath(uri: string | null): string | null {
  if (!uri?.startsWith("manuscript://")) return null;
  const path = uri.slice("manuscript://".length).replace(/^\/+/, "");
  return path ? `/${path}` : null;
}
