/** Work-draft listing, repair, preview, Apply, and Discard orchestration. */
import { createHash } from "node:crypto";
import type { YProsemirrorDocumentModel } from "@meridian/agent-edit/integration";
import type {
  DraftApplyChangesRequest,
  DraftApplyChangesResponse,
} from "@meridian/contracts/drafts";
import { branchRoomName } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId, UserId, WorkId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { CollabDrafts, DraftDiscardCommand } from "../contracts.js";
import type { ThreadPeerAgentEditCore } from "./agent-edit-cores.js";
import type { BranchCoordinator, BranchSnapshot } from "./branch-coordinator.js";
import type {
  BranchJournalReadStore,
  BranchJournalRow,
  BranchPushService,
  BranchReviewService,
  PushToLiveResult,
} from "./branch-push-contracts.js";
import { DraftChangeRefusal } from "./branch-push-contracts.js";
import { BranchCorruptError } from "./branch-resolver.js";
import type { ReviewableDraft } from "./branch-review.js";
import { documentEffectsEqual } from "./document-effect.js";
import { documentRevision } from "./document-revision.js";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import type {
  ApplicationBranchStore,
  WorkDraftDiscard,
  WorkDraftEmptySettlement,
} from "./ports/application-branch-store.js";
import { documentTitleFromUri } from "./reversal-notices.js";
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
  branchCoordinator: BranchCoordinator;
  branchJournal: BranchJournalReadStore;
  branchPush: BranchPushService;
  branchReview: BranchReviewService;
  workDraftPending: WorkDraftPending;
  model: YProsemirrorDocumentModel;
  agentEdit: ThreadPeerAgentEditCore;
  resolveThreadTitles(threadIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  readLiveReviewCut(documentId: string): Promise<{ state: Uint8Array; revision: string }>;
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
    const liveState = await input.readLiveReviewCut(command.documentId);
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
        const rows = await input.branchJournal.listReviewableJournalRows(
          branch.branchId,
          branch.generation,
        );
        const draftUpdates = reviewUpdates(rows);
        const review = computeDraftReviewHunks({
          liveDoc,
          draftDoc: branch.doc,
          model: input.model,
          draftUpdates,
        });
        if (review.diagnostics.length)
          input.diagnostics.unattributedHunks({
            documentId: command.documentId,
            draftId: command.draftId,
            hunkIds: review.diagnostics.map((diagnostic) => diagnostic.hunkId),
          });
        const threadIds = [
          ...new Set(
            rows
              .filter((row) => row.source === "agent" && row.threadId)
              .map((row) => row.threadId as string),
          ),
        ];
        const titles = await input.resolveThreadTitles(threadIds);
        const operations = review.operations.map((operation) => {
          if (operation.kind !== "agent") return operation;
          const row = rows.find(
            (row) =>
              operation.sourceUpdateIds.includes(row.id as never) &&
              row.source === "agent" &&
              row.threadId,
          );
          return row?.threadId
            ? {
                ...operation,
                actorThreadId: row.threadId,
                ...(titles.has(row.threadId) ? { actorThreadTitle: titles.get(row.threadId) } : {}),
              }
            : operation;
        });
        return {
          status: "active" as const,
          draftId: command.draftId,
          reviewRoomName: branchRoomName(branch.branchId, branch.generation),
          isNewDocument: await isDraftOnlyManifestDocument(command),
          liveRevisionToken: liveState.revision,
          draftRevisionToken: draftReviewRevision(branch.generation, branch.doc, rows),
          inlineModelPresent: true as const,
          operations,
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
    },
    requireCompleteClass: boolean,
  ) {
    return async (snapshot: BranchSnapshot, rows: BranchJournalRow[]) => {
      const liveCut = await input.readLiveReviewCut(command.documentId);
      const liveDoc = createCollabYDoc({ gc: false });
      const draftDoc = createCollabYDoc({ gc: false });
      try {
        Y.applyUpdate(liveDoc, liveCut.state);
        Y.applyUpdate(draftDoc, snapshot.state);
        const draftUpdates = reviewUpdates(rows);
        const draftRevisionToken = draftReviewRevision(snapshot.generation, draftDoc, rows);
        if (
          command.liveRevisionToken !== liveCut.revision ||
          command.draftRevisionToken !== draftRevisionToken
        )
          throw new DraftChangeRefusal("stale");
        const preview = computeDraftReviewHunks({
          liveDoc,
          draftDoc,
          model: input.model,
          draftUpdates,
        });
        const requested = new Set(command.operationIds);
        if (
          !requested.size ||
          [...requested].some((id) => !preview.operations.some((op) => op.operationId === id))
        )
          throw new DraftChangeRefusal("gone");
        const classes = new Set(
          preview.operations
            .filter((op) => requested.has(op.operationId))
            .map((op) => op.closureClassId),
        );
        const selected = preview.operations.filter((op) => classes.has(op.closureClassId));
        if (selected.some((op) => op.canApplyOrDiscard === false))
          throw new DraftChangeRefusal("incomplete_class");

        if (requireCompleteClass && selected.some((op) => !requested.has(op.operationId)))
          throw new DraftChangeRefusal("incomplete_class");
        return {
          journalIds: [...new Set(selected.flatMap((op) => op.closureUpdateIds))],
          expectedLiveRevision: liveCut.revision,
          operationIds: selected.map((op) => op.operationId),
          closureClassIds: [...classes],
        };
      } finally {
        liveDoc.destroy();
        draftDoc.destroy();
      }
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
          if (await isDraftOnlyManifestDocument(command))
            throw new DraftChangeRefusal("draft_only");
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
        await input.branchReview.discardSelected({
          branchId: branch.branchId,
          selectRows: reviewSelection({ ...command, operationIds: command.operationIds }, false),
          reviewedByUserId: command.userId,
        });
        return {
          status: "discarded" as const,
          draftId: command.draftId,
          ...(await completeDisposition(command)),
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

function manuscriptContextPath(uri: string | null): string | null {
  if (!uri?.startsWith("manuscript://")) return null;
  const path = uri.slice("manuscript://".length).replace(/^\/+/, "");
  return path ? `/${path}` : null;
}

function reviewUpdates(rows: readonly BranchJournalRow[]) {
  return rows.map((row) => ({
    id: row.id,
    actorTurnId: row.turnId,
    actorUserId: row.actorUserId,
    updateData: row.updateData,
    updateMeta: row.updateMeta,
  }));
}

function draftReviewRevision(
  generation: number,
  doc: Y.Doc,
  rows: readonly BranchJournalRow[],
): string {
  const journal = rows
    .map((row) => `${row.id}:${row.status}`)
    .sort()
    .join(",");
  return `d1:${createHash("sha256")
    .update(`${generation}:${documentRevision(doc)}:${journal}`)
    .digest("base64url")}`;
}
