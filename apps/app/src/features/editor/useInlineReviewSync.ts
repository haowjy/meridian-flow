/**
 * useInlineReviewSync — pushes the server hunk model into the draft editor and
 * reports model availability.
 *
 * This hook is the seam between the review query (`useDraftPreview`) and the
 * `DraftInlineReviewExtension` plugin: the extension is a passive receiver
 * of models delivered via command. The hook is the ONLY writer.
 *
 *   preview has operations+hunks          ← push InlineReviewModel into the plugin
 *   active preview without a model        ← log invariant violation and clear model
 *
 * It only projects: re-reading the preview when the draft or the live
 * manuscript changes is the review owner's (`useReviewRefresh`), so one edit is
 * one read whether or not an editor is mounted. The refresh → new model →
 * command dispatch loop is what lets the writer see their edits recolor as
 * "You" hunks: server recomputes hunks against the live draft, client just
 * receives them.
 */

import type { Editor } from "@tiptap/core";
import { useEffect, useRef } from "react";
import { useDraftPreview } from "@/client/query/useDraftPreview";
import { announceError } from "@/client/stores";
import { buildInlineReviewModel } from "@/core/editor/extensions/inline-review";

export interface UseInlineReviewSyncOptions {
  /** The mounted editor bound to the draft room. Null when not in review. */
  editor: Editor | null;
  /** Work + draft identity — same tuple `useDraftPreview` needs. */
  projectId: string | null;
  workId: string | null;
  documentId: string | null;
  draftId: string | null;
  /** When true, actually connect the extension. Callers pass true when
   *  `reviewDraftId` is set on the editor view. */
  enabled: boolean;
  /**
   * The draft generation the review shows (`InlineDraftReview.draftGeneration`).
   * A preview of another generation is not projected: its model describes a
   * room this editor is not in. Undefined while the review has not learned it.
   */
  draftGeneration?: number;
  onInlineModelAvailable?: (identity: string, documentId: string, draftId: string) => void;
  /** Fatal review-session invariant: active preview exists, but no inline model can be built. */
  onReviewSessionUnavailable?: () => void;
}

export function useInlineReviewSync(options: UseInlineReviewSyncOptions): void {
  const {
    editor,
    projectId,
    workId,
    documentId,
    draftId,
    enabled,
    draftGeneration,
    onInlineModelAvailable,
    onReviewSessionUnavailable,
  } = options;
  const { preview } = useDraftPreview(projectId, workId, documentId, draftId, {
    enabled: enabled && Boolean(projectId && workId && documentId && draftId),
  });

  // The last preview payload pushed into the plugin, so React re-renders around
  // unrelated state don't re-dispatch it. Compared by reference, not by the
  // revision tokens: `draftRevisionToken` moves with every write and
  // disposition, and a token identity would not tell a refetch that changed
  // nothing from one that did. Query structural sharing keeps the reference
  // when a refetch changed nothing.
  const lastPushedPreviewRef = useRef<unknown>(null);
  const lastFatalIdentityRef = useRef<string | null>(null);

  useEffect(() => {
    if (!editor || editor.isDestroyed || !enabled) return;
    // The extension is only mounted when review mode is active — outside of
    // review the command surface is absent, so calling it would throw.
    if (!("setInlineReviewModel" in editor.commands)) return;

    if (preview?.status !== "active") {
      if (lastPushedPreviewRef.current != null) {
        editor.commands.setInlineReviewModel(null);
        lastPushedPreviewRef.current = null;
      }
      return;
    }

    const reviewId = preview.draftId;
    if (draftGeneration !== undefined && preview.draftGeneration !== draftGeneration) return;

    if (!preview.inlineModelPresent) {
      const fatalIdentity = `${reviewId}:${preview.liveRevisionToken}:${preview.draftRevisionToken}`;
      const message = "Draft review is unavailable. Close the review and try again.";
      console.error("Active draft preview is missing its inline review model", {
        documentId,
        draftId: reviewId,
      });
      if (lastPushedPreviewRef.current != null) {
        editor.commands.setInlineReviewModel(null);
        lastPushedPreviewRef.current = null;
      }
      if (lastFatalIdentityRef.current !== fatalIdentity) {
        lastFatalIdentityRef.current = fatalIdentity;
        onReviewSessionUnavailable?.();
        announceError(message);
      }
      return;
    }

    const operations = preview.operations;
    const hunks = preview.hunks;
    if (!documentId) return;

    const previewIdentity = `${reviewId}:${preview.liveRevisionToken}:${preview.draftRevisionToken}`;
    if (lastPushedPreviewRef.current === preview) return;

    const model = buildInlineReviewModel({
      liveRevisionToken: preview.liveRevisionToken,
      draftRevisionToken: preview.draftRevisionToken,
      operations,
      hunks,
    });
    editor.commands.setInlineReviewModel(model);
    lastPushedPreviewRef.current = preview;
    lastFatalIdentityRef.current = null;
    onInlineModelAvailable?.(previewIdentity, documentId, reviewId);
  }, [
    editor,
    enabled,
    preview,
    draftGeneration,
    documentId,
    onInlineModelAvailable,
    onReviewSessionUnavailable,
  ]);
}
