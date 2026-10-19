/** Inline-review plugin synchronization; B2 reconnects this to its draft owner. */
import type { Editor } from "@tiptap/core";

export type UseInlineReviewSyncOptions = {
  editor: Editor | null;
  projectId: string;
  workId: string;
  documentId: string;
  itemKey: string;
  draftGeneration?: number;
  onInlineModelAvailable: (identity: string, documentId: string, itemKey: string) => void;
};

export function useInlineReviewSync(_options: UseInlineReviewSyncOptions): void {
  // B2: command owner
}
