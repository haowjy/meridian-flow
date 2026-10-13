/** Pure preview and closed-set selection from one detached authority observation. */
import { createHash } from "node:crypto";
import { bytesEqual, type YProsemirrorDocumentModel } from "@meridian/agent-edit/integration";
import { branchRoomName } from "@meridian/contracts/protocol";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { ReviewSelectionCommand } from "../contracts.js";
import type { BranchSnapshot } from "./branch-coordinator.js";
import {
  type BranchJournalRow,
  BranchPushCommitConflictError,
  branchJournalRevision,
  DraftChangeRefusal,
} from "./branch-push-contracts.js";
import { documentDifference } from "./document-difference.js";
import { documentRevision } from "./document-revision.js";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import type { DraftReviewOperationInternal } from "./draft-review-types.js";
import type { ReviewCut } from "./ports/review-cut.js";

export function deriveReviewCut(cut: ReviewCut, model: YProsemirrorDocumentModel) {
  const liveDoc = createCollabYDoc({ gc: false });
  const draftDoc = createCollabYDoc({ gc: false });
  try {
    Y.applyUpdate(liveDoc, cut.live.state);
    Y.applyUpdate(draftDoc, cut.branch.state);
    const rows = reviewRows(cut);
    const review = computeDraftReviewHunks({
      liveDoc,
      draftDoc,
      model,
      draftUpdates: rows.map((row) => ({
        id: row.id,
        actorTurnId: row.turnId,
        actorUserId: row.actorUserId,
        updateData: row.updateData,
        updateMeta: row.updateMeta,
      })),
    });
    const tokens = classAdmissionTokens(liveDoc, rows, review.operations, model);
    const operations = review.operations.map((raw) => {
      const admissionToken = tokens.get(raw.closureClassId);
      if (!admissionToken) throw new Error("Review class has no admission evidence");
      const operation = { ...raw, admissionToken };
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
            ...(row.toolCallId ? { actorToolCallId: row.toolCallId } : {}),
            ...(cut.threadTitles.has(row.threadId)
              ? { actorThreadTitle: cut.threadTitles.get(row.threadId) }
              : {}),
          }
        : operation;
    });
    // History statuses and manifest membership are part of the observation,
    // even when they change neither prose nor the Yjs state vector.
    const draftRevisionToken = `d2:${createHash("sha256")
      .update(
        JSON.stringify([
          cut.branch.branchId,
          cut.branch.generation,
          documentRevision(draftDoc, cut.links.draft),
          documentRevision(liveDoc, cut.links.live),
          cut.live.revision,
          branchJournalRevision(cut.history),
          cut.membership,
        ]),
      )
      .digest("base64url")}`;
    return {
      diagnostics: review.diagnostics,
      preview: {
        status: "active" as const,
        draftId: cut.branch.branchId,
        branchGeneration: cut.branch.generation,
        reviewRoomName: branchRoomName(cut.branch.branchId, cut.branch.generation),
        isNewDocument:
          cut.membership.draft.includes(cut.branch.documentId) &&
          !cut.membership.live.includes(cut.branch.documentId),
        liveRevisionToken: cut.live.revision,
        draftRevisionToken,
        operations,
        hunks: review.hunks,
      },
    };
  } finally {
    liveDoc.destroy();
    draftDoc.destroy();
  }
}

export function selectReviewCut(
  cut: ReviewCut,
  model: YProsemirrorDocumentModel,
  snapshot: BranchSnapshot,
  rows: readonly BranchJournalRow[],
  command: ReviewSelectionCommand,
) {
  // Selection must describe the exact basis the existing durability protocol
  // will admit, not a newer independently captured branch or row-status view.
  if (
    cut.branch.generation !== snapshot.generation ||
    !bytesEqual(cut.branch.state, snapshot.state) ||
    branchJournalRevision(reviewRows(cut)) !== branchJournalRevision(rows)
  )
    throw command.kind === "apply"
      ? new DraftChangeRefusal("stale")
      : new BranchPushCommitConflictError(snapshot.branchId);
  const { preview } = deriveReviewCut(cut, model);
  if (command.liveRevisionToken !== preview.liveRevisionToken)
    throw new DraftChangeRefusal("stale");
  const classes =
    command.kind === "apply" ? admitApply(preview, command) : admitDiscard(preview, command);
  const selected = preview.operations.filter((op) => classes.has(op.closureClassId));
  if (selected.some((op) => op.canApplyOrDiscard === false))
    throw new DraftChangeRefusal("incomplete_class");
  return {
    journalIds: [...new Set(selected.flatMap((op) => op.closureUpdateIds))],
    expectedLiveRevision: cut.live.revision,
    operationIds: selected.map((op) => op.operationId),
    closureClassIds: [...classes],
  };
}

type SelectionPreview = ReturnType<typeof deriveReviewCut>["preview"];

function admitApply(
  preview: SelectionPreview,
  command: Extract<ReviewSelectionCommand, { kind: "apply" }>,
): Set<string> {
  // Keep fence precedence: stale observations cannot be classified as gone or draft-only.
  if (command.draftRevisionToken !== preview.draftRevisionToken)
    throw new DraftChangeRefusal("stale");
  if (preview.isNewDocument) throw new DraftChangeRefusal("whole_item");
  const requested = new Set(command.operationIds);
  if (
    !requested.size ||
    [...requested].some((id) => !preview.operations.some((op) => op.operationId === id))
  )
    throw new DraftChangeRefusal("gone");
  const classes = new Set(
    preview.operations.filter((op) => requested.has(op.operationId)).map((op) => op.closureClassId),
  );
  if (
    preview.operations.some(
      (op) => classes.has(op.closureClassId) && !requested.has(op.operationId),
    )
  )
    throw new DraftChangeRefusal("incomplete_class");
  return classes;
}

function admitDiscard(
  preview: SelectionPreview,
  command: Extract<ReviewSelectionCommand, { kind: "discard" }>,
): Set<string> {
  const classes = new Set(command.closureClassIds);
  if (!classes.size) throw new DraftChangeRefusal("gone");
  if ([...classes].some((id) => !preview.operations.some((op) => op.closureClassId === id))) {
    // Immutable members classify growth versus disappearance only; they never
    // authorize a replacement class or widen the clicked class/token selection.
    const clickedParts = new Set(command.memberPartKeys);
    const survives = preview.operations.some(
      (op) => op.partKey !== undefined && clickedParts.has(op.partKey),
    );
    throw new DraftChangeRefusal(survives ? "stale" : "gone");
  }
  const expectedTokens = new Set(command.admissionTokens);
  const currentTokens = new Set(
    preview.operations
      .filter((op) => classes.has(op.closureClassId))
      .map((op) => op.admissionToken),
  );
  if (
    !expectedTokens.size ||
    expectedTokens.size !== currentTokens.size ||
    [...currentTokens].some((token) => !expectedTokens.has(token))
  )
    throw new DraftChangeRefusal("stale");
  return classes;
}

function reviewRows(cut: ReviewCut) {
  return cut.history.filter((row) => row.status === "active" || row.status === "rollback_pending");
}

/** Closed rows replay their full rich effect without incorporating independent draft typing. */
function classAdmissionTokens(
  liveDoc: Y.Doc,
  rows: readonly BranchJournalRow[],
  operations: readonly DraftReviewOperationInternal[],
  model: YProsemirrorDocumentModel,
): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const operation of operations) {
    if (tokens.has(operation.closureClassId)) continue;
    const closed = rows.filter((row) => operation.closureUpdateIds.includes(row.id as never));
    const effect = createCollabYDoc({ gc: false });
    try {
      Y.applyUpdate(effect, Y.encodeStateAsUpdate(liveDoc));
      for (const row of closed) Y.applyUpdate(effect, row.updateData);
      // Re-journaling preserves bytes and immutable metadata, not physical row IDs.
      // Keep every row (including non-visible deletions), with multiplicity.
      const membership = closed
        .map((row) =>
          JSON.stringify([
            row.status,
            row.source,
            row.threadId,
            row.turnId,
            row.actorUserId,
            row.updateMeta,
            row.wId,
            row.toolCallId,
            row.draftBaseUpdateSeq,
            Buffer.from(row.updateData).toString("base64"),
          ]),
        )
        .sort();
      const richEffect = documentDifference(liveDoc, effect, model).flatMap((entry) => {
        if (entry.kind === "equal") return [];
        return [
          {
            kind: entry.kind,
            ...("live" in entry ? { before: [entry.live.identity, entry.live.content] } : {}),
            ...("draft" in entry ? { after: [entry.draft.identity, entry.draft.content] } : {}),
          },
        ];
      });
      const liveManifest = liveDoc.getMap("documents");
      const effectManifest = effect.getMap("documents");
      const manifestEffect = [...new Set([...liveManifest.keys(), ...effectManifest.keys()])]
        .sort()
        .filter(
          (id) =>
            liveManifest.has(id) !== effectManifest.has(id) ||
            liveManifest.get(id) !== effectManifest.get(id),
        )
        .map((id) => [
          id,
          liveManifest.has(id),
          liveManifest.get(id),
          effectManifest.has(id),
          effectManifest.get(id),
        ]);
      tokens.set(
        operation.closureClassId,
        `admission:v1:${createHash("sha256")
          .update(
            JSON.stringify([operation.closureClassId, membership, richEffect, manifestEffect]),
          )
          .digest("base64url")}`,
      );
    } finally {
      effect.destroy();
    }
  }
  return tokens;
}
