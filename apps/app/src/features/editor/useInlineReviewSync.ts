/** Attach the editor to the room's projection, then release the paint cover only once its own frame exists. */
import type { Editor } from "@tiptap/core";
import { useEffect } from "react";
import type { DocumentSession } from "@/core/editor/document-session";
import { useReviewRuntime, useReviewState } from "@/features/draft-review/useReviewRuntime";

export function useInlineReviewSync({
  editor,
  session,
  onInlineModelAvailable,
}: {
  editor: Editor | null;
  session: DocumentSession | null;
  onInlineModelAvailable?: () => void;
}) {
  const runtime = useReviewRuntime(session);
  const { frame } = useReviewState(runtime);
  useEffect(() => {
    if (editor && !editor.isDestroyed) return runtime?.attachEditor(editor);
  }, [runtime, editor]);
  useEffect(() => {
    if (frame && editor && frame.doc === editor.state.doc) onInlineModelAvailable?.();
  }, [frame, editor, onInlineModelAvailable]);
}
