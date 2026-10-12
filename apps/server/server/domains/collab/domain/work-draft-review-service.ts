/** Work-draft listing, preview, Apply, and Discard orchestration. */

import type { YProsemirrorDocumentModel } from "@meridian/agent-edit/integration";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type {
  DraftApplyChangesRequest,
  DraftApplyChangesResponse,
} from "@meridian/contracts/drafts";
import type { DocumentId, ProjectId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { CollabDrafts, DraftDiscardCommand } from "../contracts.js";
import type { ThreadPeerAgentEditCore } from "./agent-edit-cores.js";
import type { BranchSnapshot } from "./branch-coordinator.js";
import type {
  BranchJournalRow,
  BranchPushService,
  BranchReviewService,
  PushToLiveResult,
} from "./branch-push-contracts.js";
import { DraftChangeRefusal } from "./branch-push-contracts.js";
import { BranchCorruptError } from "./branch-resolver.js";
import type { ReviewableDraft } from "./branch-review.js";
import { documentEffectsEqual } from "./document-content.js";
import type {
  ApplicationBranchStore,
  WorkDraftDiscard,
  WorkDraftEmptySettlement,
} from "./ports/application-branch-store.js";
import type { ReadReviewCut } from "./ports/review-cut.js";
import { documentTitleFromUri } from "./reversal-notices.js";
import { deriveReviewCut, selectReviewCut } from "./review-cut.js";
import type { WorkDraftPending } from "./work-draft-pending.js";

export type DraftReviewDiagnostics = {
  dispositionMaintenanceFailed(detail: {
    documentId: string;
    draftId: string;
    cause: unknown;
  }): void;
  unattributedHunks(detail: { documentId: string; draftId: string; hunkIds: string[] }): void;
};

export function createWorkDraftReviewService(input: {
  diagnostics: DraftReviewDiagnostics;
  branches: ApplicationBranchStore;
  discardWorkDraft: WorkDraftDiscard;
  settleEmptyDraft: WorkDraftEmptySettlement;
  branchPush: BranchPushService;
  branchReview: BranchReviewService;
  workDraftPending: WorkDraftPending;
  model: YProsemirrorDocumentModel;
  agentEdit: ThreadPeerAgentEditCore;
  resolveThreadTitles(threadIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  resolveDocumentUris(documentIds: readonly string[]): Promise<ReadonlyMap<string, string | null>>;
  readReviewCut: ReadReviewCut;
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
    const drafts: ReviewableDraft[] = [];
    const pending = await input.workDraftPending.list(workId);
    const uris = await input.resolveDocumentUris(pending.map(({ branch }) => branch.documentId));
    const titles = await input.resolveThreadTitles([
      ...new Set(pending.flatMap(({ actorThreadIds }) => actorThreadIds)),
    ]);
    for (const { branch, actorThreadIds } of pending) {
      const uri = uris.get(branch.documentId) ?? null;
      const location = uri ? parseUnifiedContextUri(uri) : null;
      drafts.push({
        draftId: branch.branchId,
        documentId: branch.documentId,
        workId,
        status: "active",
        draftGeneration: branch.generation,
        actorThreads: actorThreadIds.map((threadId) => ({
          threadId,
          title: titles.get(threadId) ?? null,
        })),
        updatedAt: branch.updatedAt,
        documentName: documentTitleFromUri(uri),
        contextLocation: location?.ok
          ? { scheme: location.value.scheme, path: `/${location.value.path}` }
          : null,
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
    draftId: string;
  }) {
    const cut = await input.readReviewCut(command).catch((cause) => {
      if (cause instanceof DraftChangeRefusal && cause.status === "gone") return null;
      if (cause instanceof BranchCorruptError && cause.generation !== undefined)
        return {
          status: "corrupt" as const,
          draftId: cause.branchId,
          draftGeneration: cause.generation,
        };
      throw cause;
    });
    if (!cut) return { status: "gone" as const, draftId: command.draftId };
    if ("status" in cut) return cut;
    const { preview, diagnostics } = deriveReviewCut(cut, input.model);
    if (diagnostics.length)
      input.diagnostics.unattributedHunks({
        documentId: command.documentId,
        draftId: command.draftId,
        hunkIds: diagnostics.map((diagnostic) => diagnostic.hunkId),
      });
    return preview;
  }

  async function pushNewDocumentToLiveWithManifest(command: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    branchId: string;
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

    if (
      command.projectId &&
      (await isDraftOnlyManifestDocument({
        projectId: command.projectId,
        workId: command.workId,
        documentId: command.documentId,
      }))
    ) {
      await pushNewDocumentToLiveWithManifest({
        projectId: command.projectId,
        workId: command.workId,
        documentId: command.documentId,
        branchId: branch.branchId,
        userId: command.userId,
        signal: command.signal,
      });
    } else {
      await input.branchPush.pushToLive({
        branchId: branch.branchId,
        pushedByUserId: command.userId,
        signal: command.signal,
      });
    }
    return { status: "applied" as const, draftId: command.draftId };
  }

  /** The disposition is durable before optional generation cleanup begins. */
  async function completeDisposition(command: {
    workId: WorkId;
    documentId: DocumentId;
    draftId: string;
  }) {
    try {
      return await input.settleEmptyDraft({
        workId: command.workId,
        documentId: command.documentId,
        branchId: command.draftId,
        isEmpty: documentEffectsEqual,
        disposition: (rows) =>
          rows.some((row) => row.status === "pushed") ? "applied" : "discarded",
      });
    } catch (cause) {
      // Neither cleanup nor diagnostic delivery can turn a durable disposition
      // into a rejection that invites the writer to retry it.
      try {
        input.diagnostics.dispositionMaintenanceFailed({
          documentId: command.documentId,
          draftId: command.draftId,
          cause,
        });
      } catch {}
      return { draftClosed: false } as const;
    }
  }

  function reviewSelection(
    command: {
      operationIds: string[];
      liveRevisionToken?: string;
      draftRevisionToken?: string;
      documentId: DocumentId;
      workId: WorkId;
      projectId?: ProjectId;
    },
    requireCompleteClass: boolean,
  ) {
    return async (snapshot: BranchSnapshot, rows: BranchJournalRow[]) => {
      const cut = await input.readReviewCut({ ...command, draftId: snapshot.branchId });
      return selectReviewCut(cut, input.model, snapshot, rows, command, requireCompleteClass);
    };
  }

  async function applyWorkDraftChanges(
    command: DraftApplyChangesRequest & {
      projectId?: ProjectId;
      workId: WorkId;
      documentId: DocumentId;
      userId: UserId;
      signal?: AbortSignal;
    },
  ): Promise<DraftApplyChangesResponse> {
    const branch = await resolveActiveWorkDraft(command);
    if (!branch) return { status: "gone", draftId: command.draftId };
    let appliedOperations: string[] = [];
    let appliedClasses: string[] = [];
    try {
      await input.branchPush.pushSelectedToLive({
        branchId: branch.branchId,
        pushedByUserId: command.userId,
        signal: command.signal,
        selectRows: async (snapshot, rows) => {
          const selection = await reviewSelection(command, true)(snapshot, rows);
          appliedOperations = selection.operationIds;
          appliedClasses = selection.closureClassIds;
          return selection;
        },
      });
      return {
        status: "applied",
        draftId: command.draftId,
        operationIds: appliedOperations,
        closureClassIds: appliedClasses,
        ...(await completeDisposition(command)),
      };
    } catch (cause) {
      if (cause instanceof DraftChangeRefusal)
        return { status: cause.status, draftId: command.draftId };
      throw cause;
    }
  }

  async function discardWorkDraft(
    command: DraftDiscardCommand & {
      projectId?: ProjectId;
      workId: WorkId;
      documentId: DocumentId;
      draftId: string;
      userId?: UserId;
      threadId?: string;
    },
  ) {
    const projectId = command.projectId;
    const branch = await resolveActiveWorkDraft(command);
    if (!branch) return { status: "discarded" as const, draftId: command.draftId };

    if (command.operationIds !== undefined) {
      if (!command.operationIds.length)
        return { status: "gone" as const, draftId: command.draftId };
      if (!command.liveRevisionToken || !command.draftRevisionToken)
        return { status: "stale" as const, draftId: command.draftId };
      try {
        const discarded = await input.branchReview.discardSelected({
          branchId: branch.branchId,
          selectRows: reviewSelection({ ...command, operationIds: command.operationIds }, false),
          reviewedByUserId: command.userId,
        });
        return {
          status: "discarded" as const,
          draftId: command.draftId,
          draftClosed: discarded.status === "discarded" && discarded.draftClosed === true,
          ...(discarded.status === "discarded" && discarded.draftDisposition
            ? { draftDisposition: discarded.draftDisposition }
            : {}),
        };
      } catch (cause) {
        if (cause instanceof DraftChangeRefusal)
          return { status: cause.status, draftId: command.draftId };
        throw cause;
      }
    } else {
      const draftOnly =
        projectId &&
        (await isDraftOnlyManifestDocument({
          projectId,
          workId: command.workId,
          documentId: command.documentId,
        }));
      await input.discardWorkDraft({
        draftOnlyProjectId: draftOnly ? projectId : undefined,
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
      applyWorkDraftChanges,
      async discardWorkDraft(command) {
        return discardWorkDraft(command);
      },
    },
  };
}
