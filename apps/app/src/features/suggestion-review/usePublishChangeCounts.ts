import { pendingChanges } from "@meridian/suggestions";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { useEffect } from "react";
import { publishTabChangeCounts } from "@/client/query/tab-change-counts";
import { authorsIn } from "@/core/editor/extensions/suggestion-mode";

/**
 * Publishes `editor`'s pending changes by Work for the lists that count them
 * (`tab-change-counts.ts`). `editor` is null until it holds the document: an editor still empty
 * would count nothing pending. Counted once edits pause, off the keystroke.
 */
export function usePublishChangeCounts(documentId: string, editor: Editor | null): void {
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      if (editor.isDestroyed) return;
      const pending = pendingChanges(editor.state.doc, authorsIn(editor.state));
      publishTabChangeCounts(
        editor,
        documentId,
        Object.fromEntries(Object.entries(pending).map(([work, { changes }]) => [work, changes])),
      );
    };
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged) return;
      clearTimeout(timer);
      timer = setTimeout(publish, 100);
    };
    publish();
    editor.on("transaction", onTransaction);
    return () => {
      clearTimeout(timer);
      editor.off("transaction", onTransaction);
      publishTabChangeCounts(editor, documentId, null);
    };
  }, [documentId, editor]);
}
