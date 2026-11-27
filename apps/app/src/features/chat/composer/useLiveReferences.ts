import type { Editor } from "@tiptap/core";
import { useEffect } from "react";
import type {
  ComposerDraftSnapshot,
  ComposerReferenceAttrs,
} from "@/client/chat-submissions/composer-document";
import type { AuthoritativeReference } from "@/core/completion";
import type { ReferenceBrowserCatalog } from "@/core/editor/extensions/at-reference";

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
      const synced = catalog.port.status("") === "ready";
      const transaction = editor.state.tr;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== "composerReference") return;
        const reference = node.attrs.reference as ComposerReferenceAttrs;
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
      if (synced) restored.clear();
      if (!transaction.docChanged) return;
      editor.view.dispatch(transaction.setMeta("addToHistory", false));
    };
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
