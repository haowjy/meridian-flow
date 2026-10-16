/**
 * useInlineReviewSync: gives the mounted draft editor to the draft's review runtime, which projects the
 * editor's text and paints the frame into the `DraftInlineReviewExtension`. The header, the list, the
 * stepper and the chip read the same frames through `useReviewState`.
 *
 * The runtime itself (`review-runtime.ts`) is the room's; this hook adds the one fact only the editor's
 * mount knows, that its editor exists, and tells the review when its first settled frame is ready.
 */

import type { Editor } from "@tiptap/core";
import { useEffect, useMemo } from "react";
import type { DocumentSession } from "@/core/editor/document-session";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { type ReviewSurface, reviewRuntimeOf } from "@/features/draft-review/review-runtime";
import { useReviewRuntime, useReviewState } from "@/features/draft-review/useReviewRuntime";

export interface UseInlineReviewSyncOptions {
  /** The mounted editor bound to the draft room. Null until construction. */
  editor: Editor | null;
  /** The draft room's session, for its sync state. */
  session: DocumentSession | null;
  documentId: string;
  itemKey: string;
  /** Which host mounts this editor, so the header of that host acts in it. */
  surface?: ReviewSurface;
  /** Called once the review has its first settled frame. */
  onInlineModelAvailable?: (identity: string, documentId: string, itemKey: string) => void;
}

export function useInlineReviewSync(options: UseInlineReviewSyncOptions): void {
  const { editor, session, documentId, itemKey, surface, onInlineModelAvailable } = options;
  const { controller } = useDraftReview();
  const { projectId, workId } = controller;
  const draft = useMemo(
    () => ({ projectId, workId, documentId, itemKey }),
    [projectId, workId, documentId, itemKey],
  );
  useReviewRuntime(draft, session);
  const ready = useReviewState(draft, (state) => state.ready);

  useEffect(() => {
    if (!editor || editor.isDestroyed || !session) return;
    return reviewRuntimeOf(draft)?.attachEditor(editor, surface);
  }, [editor, session, draft, surface]);

  useEffect(() => {
    if (ready) onInlineModelAvailable?.(`${itemKey}:projection`, documentId, itemKey);
  }, [ready, onInlineModelAvailable, documentId, itemKey]);
}
