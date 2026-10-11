/** Revalidate restored atoms without making a cold/offline catalog erase words. */
import type { CatalogScope } from "@meridian/contracts/protocol";
import type { Editor } from "@tiptap/core";
import { useEffect } from "react";
import type { AtReferenceCatalog } from "@/core/editor/extensions/at-reference";
import type { ComposerDraftSnapshot, ComposerReferenceAttrs } from "./composer-document";

export function useRestoredReferences(
  editor: Editor | null,
  draft: ComposerDraftSnapshot | null | undefined,
  catalog: AtReferenceCatalog | null,
) {
  useEffect(() => {
    if (!editor || !draft || !catalog) return;
    const abort = new AbortController();
    const scopes = new Map<string, { scope: CatalogScope; references: Set<string> }>();
    const walk = (node: ComposerDraftSnapshot["doc"]) => {
      if (node.type === "composerReference") {
        const reference = node.attrs?.reference as ComposerReferenceAttrs;
        const { authority } = reference;
        const scope: CatalogScope =
          authority.kind === "work"
            ? { kind: "work", projectId: authority.projectId, workId: authority.workId }
            : authority.kind === "lineage"
              ? {
                  kind: "lineage",
                  projectId: authority.projectId,
                  rootThreadId: authority.rootThreadId,
                }
              : authority;
        const key = JSON.stringify(scope);
        const group = scopes.get(key) ?? { scope, references: new Set<string>() };
        group.references.add(JSON.stringify(reference));
        scopes.set(key, group);
      }
      node.content?.forEach(walk);
    };
    walk(draft.doc);
    for (const { scope, references } of scopes.values()) {
      void catalog.port
        .acquire(scope, abort.signal)
        .then((view) => {
          if (abort.signal.aborted || editor.isDestroyed) return;
          const existing = new Set(
            [...view.entries.values()].flatMap((entry) =>
              entry.kind === "file" ? [entry.entryId] : [],
            ),
          );
          const missing: { from: number; to: number }[] = [];
          editor.state.doc.descendants((node, pos) => {
            if (node.type.name !== "composerReference") return;
            const reference = node.attrs.reference as ComposerReferenceAttrs;
            if (references.has(JSON.stringify(reference)) && !existing.has(reference.documentId))
              missing.push({ from: pos, to: pos + node.nodeSize });
          });
          if (!missing.length) return;
          const transaction = editor.state.tr;
          for (const { from, to } of missing.reverse()) transaction.delete(from, to);
          editor.view.dispatch(transaction);
        })
        .catch(() => {
          /* Offline or unavailable is not proof that a resource is gone. */
        });
    }
    return () => abort.abort();
  }, [catalog, draft, editor]);
}
