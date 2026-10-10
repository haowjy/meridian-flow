/**
 * useInlineReviewSync — pushes the server hunk model into the draft editor and
 * reports model availability.
 *
 * This hook is the seam between the review query (`useDraftPreview`) and the
 * `DraftInlineReviewExtension` plugin: the extension is a passive receiver
 * of models delivered via command. The hook is the ONLY writer.
 *
 *   preview has operations+hunks          ← push InlineReviewModel into the plugin
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
import { buildInlineReviewModel } from "@/core/editor/extensions/inline-review";

export interface UseInlineReviewSyncOptions {
  /** The mounted editor bound to the draft room. Null until construction. */
  editor: Editor | null;
  /** Work + draft identity — same tuple `useDraftPreview` needs. */
  projectId: string;
  workId: string;
  documentId: string;
  draftId: string;
  /**
   * The draft generation the review shows (`InlineDraftReview.draftGeneration`).
   * A preview of another generation is not projected: its model describes a
   * room this editor is not in. Undefined while the review has not learned it.
   */
  draftGeneration?: number;
  onInlineModelAvailable?: (identity: string, documentId: string, draftId: string) => void;
}

export function useInlineReviewSync(options: UseInlineReviewSyncOptions): void {
  const {
    editor,
    projectId,
    workId,
    documentId,
    draftId,
    draftGeneration,
    onInlineModelAvailable,
  } = options;
  const { preview } = useDraftPreview(projectId, workId, documentId, draftId, {
    enabled: Boolean(projectId && workId && documentId && draftId),
  });

  // The last preview payload pushed into the plugin, so React re-renders around
  // unrelated state don't re-dispatch it. Compared by reference, not by the
  // revision tokens: `draftRevisionToken` moves with every write and
  // disposition, and a token identity would not tell a refetch that changed
  // nothing from one that did. Query structural sharing keeps the reference
  // when a refetch changed nothing.
  const lastPushedPreviewRef = useRef<unknown>(null);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (preview?.status !== "active") {
      if (lastPushedPreviewRef.current != null) {
        editor.commands.setInlineReviewModel(null);
        lastPushedPreviewRef.current = null;
      }
      return;
    }

    const reviewId = preview.draftId;
    if (draftGeneration !== undefined && preview.draftGeneration !== draftGeneration) return;

    const operations = preview.operations;
    const hunks = preview.hunks;

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
    onInlineModelAvailable?.(previewIdentity, documentId, reviewId);
  }, [editor, preview, draftGeneration, documentId, onInlineModelAvailable]);
}
