/**
 * Keeps the Composer's reference atoms naming what the project's list shows now. A document or
 * folder renamed or moved anywhere is respelled at once, so the chip reads its current name and
 * Send carries the address admission checks. Atoms restored with the draft are also revalidated
 * without letting a cold or offline list erase words: a document the list does not show is gone
 * only once the list has synced. A folder whose list entry is gone stays; admission flattens it.
 */
import type { Editor } from "@tiptap/core";
import { useEffect } from "react";
import type { AuthoritativeReference } from "@/core/completion";
import type { ReferenceBrowserCatalog } from "@/core/editor/extensions/at-reference";
import type { ComposerDraftSnapshot, ComposerReferenceAttrs } from "./composer-document";

export function useLiveReferences(
  editor: Editor | null,
  draft: ComposerDraftSnapshot | null | undefined,
  catalog: ReferenceBrowserCatalog | null,
) {
  useEffect(() => {
    if (!editor || !catalog) return;
    const restored = new Set<string>();
    const walk = (node: ComposerDraftSnapshot["doc"]) => {
      const reference = node.attrs?.reference as ComposerReferenceAttrs | undefined;
      if (node.type === "composerReference" && reference?.kind === "document")
        restored.add(JSON.stringify(reference));
      node.content?.forEach(walk);
    };
    if (draft) walk(draft.doc);
    const sync = () => {
      if (editor.isDestroyed) return;
      // A source id the port does not know answers for the lists as a whole.
      const synced = catalog.port.status("") === "ready";
      const transaction = editor.state.tr;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== "composerReference") return;
        const reference = node.attrs.reference as ComposerReferenceAttrs;
        // An attached upload is spelled by its intake, which admission checks instead.
        if (reference.kind === "document" && reference.upload) return;
        const row = catalog.resolveReference(
          reference.kind === "document"
            ? { kind: "file", id: reference.documentId }
            : { kind: "folder", id: reference.folderId },
        );
        if (!row) {
          if (synced && reference.kind === "document" && restored.has(JSON.stringify(reference)))
            transaction.delete(
              transaction.mapping.map(pos),
              transaction.mapping.map(pos + node.nodeSize),
            );
          return;
        }
        const next = respelled(reference, row.action.reference);
        if (next)
          transaction.setNodeMarkup(transaction.mapping.map(pos), undefined, { reference: next });
      });
      // Only the draft as it came back is revalidated, once; a gone document picked since keeps its chip.
      if (synced) restored.clear();
      if (!transaction.docChanged) return;
      // Not the writer's edit: Undo must not bring the old name back.
      editor.view.dispatch(transaction.setMeta("addToHistory", false));
    };
    // Callers announce changes from React effects, and Tiptap `flushSync`es a chip's React node
    // view when a respelled chip remounts, which React forbids inside a commit; a microtask is
    // outside it. One pending pass reads whatever the list and draft are by then.
    let pending = false;
    let live = true;
    const schedule = () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        if (live) sync();
      });
    };
    schedule();
    const stop = catalog.port.subscribe(schedule);
    editor.on("update", schedule);
    return () => {
      live = false;
      stop();
      editor.off("update", schedule);
    };
  }, [catalog, draft, editor]);
}

/** The atom with the list's current name and address, or null when it already has them. */
function respelled(
  reference: ComposerReferenceAttrs,
  current: AuthoritativeReference,
): ComposerReferenceAttrs | null {
  if (reference.kind === "folder" && current.kind === "folder") {
    if (reference.label === current.label && reference.uri === current.uri) return null;
    return { ...reference, label: current.label, uri: current.uri };
  }
  if (reference.kind === "document" && current.kind === "document") {
    if (
      reference.label === current.label &&
      reference.uri === current.uri &&
      JSON.stringify(reference.authority) === JSON.stringify(current.authority)
    )
      return null;
    return {
      ...reference,
      label: current.label,
      uri: current.uri,
      authority: current.authority,
    };
  }
  return null;
}
