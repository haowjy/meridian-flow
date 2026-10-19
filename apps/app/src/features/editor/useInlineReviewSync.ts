/** Attach the editor to the room's projection, then release the paint cover only once its own frame exists. */
import type { Editor } from "@tiptap/core";
import { useEffect } from "react";
import type { DocumentSession } from "@/core/editor/document-session";
import type { ReviewSurface } from "@/features/draft-review/review-runtime";
import { useReviewRuntime, useReviewState } from "@/features/draft-review/useReviewRuntime";

export function useInlineReviewSync({
  editor,
  session,
  documentId,
  itemKey,
  surface,
  onInlineModelAvailable,
}: {
  editor: Editor | null;
  session: DocumentSession | null;
  documentId: string;
  itemKey: string;
  surface?: ReviewSurface;
  onInlineModelAvailable?: (identity: string, documentId: string, itemKey: string) => void;
}) {
  const runtime = useReviewRuntime(session);
  const { frame } = useReviewState(runtime);
  useEffect(() => {
    if (editor && !editor.isDestroyed) return runtime?.attachEditor(editor, surface);
  }, [runtime, editor, surface]);
  useEffect(() => {
    if (frame && editor && frame.doc === editor.state.doc)
      onInlineModelAvailable?.(`${itemKey}:projection`, documentId, itemKey);
  }, [frame, editor, itemKey, documentId, onInlineModelAvailable]);
}
