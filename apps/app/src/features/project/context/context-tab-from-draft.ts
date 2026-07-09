/**
 * context-tab-from-draft — ContextTab synthesized from a work-draft group.
 *
 * Draft-only NEW documents have no context-tree entry until accept, so the
 * route→tab auto-open (ContextPaneController → findContextFile) has nothing
 * to match and review lands on an empty pane (#153). The document itself is
 * real — its `documents` row and Yjs state exist from write time — only the
 * tree manifest entry is missing, so review entry builds the tab from draft
 * metadata instead. `openTab` is idempotent by documentId and merges
 * metadata, so when the real tree entry appears at accept the same tab is
 * refreshed in place, never duplicated.
 */
import { filetypeForPath, schemaTypeForFiletype } from "@meridian/contracts/protocol";

import type { ContextTab } from "@/client/stores";

export function contextTabFromDraftGroup(group: {
  documentId: string;
  contextPath?: string | null;
  documentName?: string | null;
}): ContextTab | null {
  const path = group.contextPath;
  if (!path) return null;
  const filetype = filetypeForPath(path);
  const schemaType = schemaTypeForFiletype(filetype);
  // Draft review only exists for Yjs-tracked editable documents; a path that
  // doesn't resolve to a schema has no editor surface to synthesize.
  if (!schemaType) return null;
  // Tab names are the path basename WITH extension (tree `nameFromPath`
  // convention); the group's `documentName` is the extension-less title.
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return {
    documentId: group.documentId,
    // The review launcher navigates with a hard-coded manuscript scheme; a
    // non-manuscript draft never reaches this path (server sends null
    // contextPath for other schemes).
    scheme: "manuscript",
    path,
    name: basename || (group.documentName ?? group.documentId),
    editable: true,
    filetype,
    schemaType,
  };
}
