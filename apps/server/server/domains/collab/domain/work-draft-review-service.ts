/**
 * Work-draft review: the list (tree state merged with branches with rows, §13.1), the
 * preview with the tokens Apply checks (§11.3), Apply through the one publication
 * (§11.4), and Discard.
 */
import type { YProsemirrorDocumentModel } from "@meridian/agent-edit/integration";
import type { DraftId, LinkView } from "@meridian/contracts";
import { branchRoomName } from "@meridian/contracts/protocol";
import type { DocumentId, UserId, WorkId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { CollabDrafts } from "../contracts.js";
import type { ThreadPeerAgentEditCore } from "./agent-edit-cores.js";
import type { BranchCoordinator } from "./branch-coordinator.js";
import type { BranchJournalReadStore, BranchReviewService } from "./branch-push-contracts.js";
import { fullStateFingerprint } from "./branch-push-transition.js";
import { BranchCorruptError, isBranchNotFoundError } from "./branch-resolver.js";
import type { ReviewableDraft } from "./branch-review.js";
import type { ApplyItemRef, DraftPublication } from "./draft-publication.js";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import type { DraftReviewItem, DraftReviewItems } from "./draft-review-items.js";
import type { Drafts } from "./drafts.js";
import type { MarkdownDocumentEngine } from "./markdown-document.js";
import type { ApplicationBranchStore, WorkDraftDiscard } from "./ports/application-branch-store.js";
import { type DocumentLinkScopes, LIVE_VIEW } from "./ports/document-link-scope.js";

export function createWorkDraftReviewService(input: {
  /** Both sides of a preview spell from one snapshot: live in the live view, the draft in its own. */
  links: DocumentLinkScopes;
  branches: ApplicationBranchStore;
  discardWorkDraft: WorkDraftDiscard;
  branchCoordinator: BranchCoordinator;
  branchJournal: BranchJournalReadStore;
  branchReview: BranchReviewService;
  liveCoordinator: {
    withDocument<T>(documentId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T>;
  };
  documents: Pick<MarkdownDocumentEngine, "serializeDocument">;
  model: YProsemirrorDocumentModel;
  agentEdit: ThreadPeerAgentEditCore;
  latestUpdateSeq(documentId: string): Promise<number>;
  drafts: Pick<Drafts, "activeForWork">;
  reviewItems: DraftReviewItems;
  publication: DraftPublication;
}): CollabDrafts {
  /** The Work's active draft and its items; none when the Work has no active draft. */
  async function workItems(
    workId: WorkId,
    options: { liveTextTokens?: boolean } = {},
  ): Promise<{ draftId: DraftId | null; items: DraftReviewItem[] }> {
    const draft = await input.drafts.activeForWork(workId);
    if (!draft) return { draftId: null, items: [] };
    return { draftId: draft.id, items: await input.reviewItems.list(draft.id, options) };
  }

  /** The legacy list: branch items with reviewable rows, hidden creates included. */
  function legacyDrafts(workId: WorkId, items: readonly DraftReviewItem[]): ReviewableDraft[] {
    return items.flatMap((item) =>
      item.draftBranchId && item.pendingRows > 0
        ? [
            {
              draftId: item.draftBranchId,
              documentId: item.documentId,
              workId,
              status: "active" as const,
              lastActorTurnId: item.lastActorTurnId,
              wordsAdded: null,
              wordsRemoved: null,
              updatedAt: item.updatedAt,
              documentName: item.documentName,
              contextPath: manuscriptContextPath(item.path),
              ...(item.isNew ? { createdDocument: true } : {}),
            },
          ]
        : [],
    );
  }

  async function itemOf(workId: WorkId, documentId: DocumentId) {
    return (
      (await workItems(workId, { liveTextTokens: false })).items.find(
        (item) => item.documentId === documentId,
      ) ?? null
    );
  }

  async function previewWorkDraftBranch(command: {
    documentId: DocumentId;
    workId: WorkId;
    draftId: string;
  }) {
    return input.links.within({ documentId: command.documentId }, async () => {
      // The live text token is the fingerprint of exactly the state the preview renders,
      // taken under the same lease (S2; deletions count, V2-H1).
      const liveState = await input.liveCoordinator.withDocument(
        command.documentId,
        async (liveDoc) => ({
          state: Y.encodeStateAsUpdate(liveDoc),
          fingerprint: fullStateFingerprint(liveDoc),
          markdown: await input.documents.serializeDocument(command.documentId, liveDoc, LIVE_VIEW),
        }),
      );
      // The Work's active draft owns the branch; a Work with none has nothing to preview.
      const activeDraft = await input.drafts.activeForWork(command.workId);
      if (!activeDraft) throw new Error("draft_not_found");
      const activeDraftId = activeDraft.id;
      const draftView: LinkView = { kind: "draft", draftId: activeDraftId };
      const item = (await input.reviewItems.list(activeDraftId, { liveTextTokens: false })).find(
        (candidate) => candidate.documentId === command.documentId,
      );
      const liveDoc = createCollabYDoc({ gc: false });
      Y.applyUpdate(liveDoc, liveState.state);
      let notice: { code: "branch_corrupt_reset"; message: string } | undefined;
      // The requested branch, lookup only: a preview never makes one (§2.5).
      const resolveRequested = () =>
        input.branches
          .resolveDraftBranch({
            draftBranchId: command.draftId,
            documentId: command.documentId,
            draftId: activeDraftId,
          })
          .catch((cause: unknown) => {
            if (isBranchNotFoundError(cause)) throw new Error("draft_not_found");
            throw cause;
          });
      try {
        let branch: { branchId: string; generation: number; doc: Y.Doc };
        try {
          branch = await resolveRequested();
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
          branch = await resolveRequested();
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
          });
          return {
            status: "active" as const,
            draftId: command.draftId,
            reviewRoomName: branchRoomName(branch.branchId, branch.generation),
            live: liveState.markdown,
            markdown: await input.documents.serializeDocument(
              command.documentId,
              branch.doc,
              draftView,
            ),
            isNewDocument: item?.isNew === true,
            liveRevisionToken: await input.latestUpdateSeq(command.documentId),
            draftRevisionToken: branch.generation,
            inlineModelPresent: true as const,
            operations: review.operations,
            hunks: review.hunks,
            ...(notice ? { notice } : {}),
            // The item as this preview rendered it: its text tokens from this cut.
            ...(item
              ? {
                  item: {
                    ...item,
                    tokens: {
                      ...item.tokens,
                      liveTextToken: liveState.fingerprint,
                      branchGenerationToken: String(branch.generation),
                    },
                  },
                }
              : {}),
          };
        } finally {
          branch.doc.destroy();
        }
      } finally {
        liveDoc.destroy();
      }
    });
  }

  /** The requested branch, while it is the Work's active draft's branch on the document. */
  async function resolveActiveWorkDraft(command: {
    draftId: string;
    documentId: DocumentId;
    workId: WorkId;
  }) {
    const draft = await input.drafts.activeForWork(command.workId);
    if (!draft) return null;
    const branch = await input.branches.getBranch(command.draftId);
    return branch?.kind === "work_draft" &&
      branch.status === "active" &&
      branch.draftId === draft.id &&
      branch.documentId === command.documentId
      ? { branch, draftId: draft.id }
      : null;
  }

  /** The legacy per-document Apply: one rendered item through the one publication (§11.4). */
  async function applyWorkDraft(command: {
    workId: WorkId;
    documentId: DocumentId;
    draftId: string;
    userId: UserId;
    tokens?: Omit<ApplyItemRef, "itemKey">;
    signal?: AbortSignal;
  }) {
    const notFound = { status: "not_found" as const, draftId: command.draftId };
    const active = await resolveActiveWorkDraft(command);
    if (!active) return notFound;
    const item = (await input.reviewItems.list(active.draftId, { liveTextTokens: false })).find(
      (candidate) =>
        candidate.documentId === command.documentId &&
        candidate.draftBranchId === active.branch.branchId,
    );
    if (!item) return notFound;
    const result = await input.publication.applyItems({
      workId: command.workId,
      draftId: active.draftId,
      selection: { kind: "rendered", items: [{ ...command.tokens, itemKey: item.itemKey }] },
      userId: command.userId,
      closeWhenEmpty: false,
      ...(command.signal ? { signal: command.signal } : {}),
    });
    if (result.status === "gone") return notFound;
    if (result.status === "stale") return { status: "stale" as const, draftId: command.draftId };
    const [applied] = result.items;
    if (!applied) return notFound;
    return applied.status === "held"
      ? { status: "held" as const, draftId: command.draftId, reason: applied.reason }
      : { status: "applied" as const, draftId: command.draftId, item: applied };
  }

  async function discardWorkDraft(command: {
    workId: WorkId;
    documentId: DocumentId;
    draftId: string;
    userId?: UserId;
    threadId?: string;
    operationIds?: string[];
  }) {
    const active = await resolveActiveWorkDraft(command);
    if (!active) return { status: "discarded" as const, draftId: command.draftId };
    const { branch } = active;

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
      // Until lane D's discardItems: a created document still hidden ends the draft's use.
      const createdBy = (await itemOf(command.workId, command.documentId))?.isNew
        ? active.draftId
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
        const { items } = await workItems(command.workId, { liveTextTokens: false });
        return legacyDrafts(command.workId, items);
      },
      async listItems(command) {
        const { draftId, items } = await workItems(command.workId, {
          liveTextTokens: command.liveTextTokens !== false,
        });
        return { draftId, drafts: legacyDrafts(command.workId, items), items };
      },
      async preview(command) {
        return previewWorkDraftBranch(command);
      },
      async applyWorkDraft(command) {
        return applyWorkDraft(command);
      },
      async applyAll(command) {
        return input.publication.applyItems({
          workId: command.workId,
          draftId: command.draftId,
          selection: { kind: "rendered", items: command.items },
          userId: command.userId,
          closeWhenEmpty: true,
          ...(command.signal ? { signal: command.signal } : {}),
        });
      },
      async discardWorkDraft(command) {
        return discardWorkDraft(command);
      },
    },
    draftSessionStats: {
      async listActiveDraftsByWork(command) {
        const { items } = await workItems(command.workId, { liveTextTokens: false });
        return legacyDrafts(command.workId, items);
      },
    },
  };
}

function manuscriptContextPath(uri: string | null): string | null {
  if (!uri?.startsWith("manuscript://")) return null;
  const path = uri.slice("manuscript://".length).replace(/^\/+/, "");
  return path ? `/${path}` : null;
}
