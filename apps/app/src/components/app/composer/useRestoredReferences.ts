/**
 * Revalidate restored document atoms without making a cold/offline list erase words: a document
 * the project's list does not show is gone only once the list has synced. A folder atom names
 * its folder by identity, not by a list it can be checked against, so it stays; admission
 * flattens one whose folder is gone.
 */
import type { Editor } from "@tiptap/core";
import { useEffect } from "react";
import type { ReferenceBrowserCatalog } from "@/core/editor/extensions/at-reference";
import type { ComposerDraftSnapshot, ComposerReferenceAttrs } from "./composer-document";

export function useRestoredReferences(
  editor: Editor | null,
  draft: ComposerDraftSnapshot | null | undefined,
  catalog: ReferenceBrowserCatalog | null,
) {
  useEffect(() => {
    if (!editor || !draft || !catalog) return;
    const restored = new Set<string>();
    const walk = (node: ComposerDraftSnapshot["doc"]) => {
      const reference = node.attrs?.reference as ComposerReferenceAttrs | undefined;
      if (node.type === "composerReference" && reference?.kind === "document")
        restored.add(JSON.stringify(reference));
      node.content?.forEach(walk);
    };
    walk(draft.doc);
    if (restored.size === 0) return;
    /** Whether the check could decide: a list that has not synced proves nothing gone. */
    const check = (): boolean => {
      if (editor.isDestroyed) return true;
      // A source id the port does not know answers for the lists as a whole.
      if (catalog.port.status("") !== "ready") return false;
      const missing: { from: number; to: number }[] = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== "composerReference") return;
        const reference = node.attrs.reference as ComposerReferenceAttrs;
        if (
          reference.kind === "document" &&
          restored.has(JSON.stringify(reference)) &&
          !catalog.resolveReference({ kind: "file", id: reference.documentId })
        )
          missing.push({ from: pos, to: pos + node.nodeSize });
      });
      if (missing.length) {
        const transaction = editor.state.tr;
        for (const { from, to } of missing.reverse()) transaction.delete(from, to);
        editor.view.dispatch(transaction);
      }
      return true;
    };
    if (check()) return;
    const stop = catalog.port.subscribe(() => {
      if (check()) stop();
    });
    return stop;
  }, [catalog, draft, editor]);
}
