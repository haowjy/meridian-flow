/**
 * context-tab-from-draft — ContextTab synthesized from a work-draft group.
 *
 * Draft-only documents (created by the draft, or deleted live while this draft
 * still has them) have no context-tree entry until Apply, so the
 * route→tab auto-open (ContextPaneController → findContextFile) has nothing
 * to match and review lands on an empty pane (#153). The document itself is
 * real — its `documents` row and Yjs state exist from write time — only the
 * tree manifest entry is missing, so review entry builds the tab from draft
 * metadata instead. Review overlays are idempotent by document, Work and draft;
 * mounted instance IDs and tokens fence their close and promotion. Live
 * metadata can enrich every overlay without changing those identities.
 *
 * Filetype/schema derive purely from the path (same contracts registry the
 * tree uses): a prose document's stored name has no extension and is markdown,
 * a visible extension (`outline.json`) states its type.
 */
import { classifyFiletype, filetypeForPath } from "@meridian/contracts/protocol";
import type { ContextTab } from "@/client/stores";
import type { ContextUri } from "@/lib/context-uri";

export function contextTabFromDraftGroup(group: {
  workId: string;
  documentId: string;
  itemKey: string;
  contextLocation?: Pick<ContextUri, "scheme" | "path"> | null;
  documentName?: string | null;
  /**
   * Live doesn't hold the document: the draft created it, or live deleted it and this
   * draft still has it. Gives the tab a review entry (draft-only) so the tab lifecycle
   * follows the draft's: cleared when Apply brings the document into the tree, closed
   * when the draft leaves the Work's list.
   */
  draftOnly?: boolean;
}): Extract<ContextTab, { kind: "tracked" }> | null {
  const location = group.contextLocation;
  if (!location?.path) return null;
  const { scheme, path } = location;
  const filetype = filetypeForPath(path);
  const classification = classifyFiletype(filetype);
  // Draft review only exists for Yjs-tracked editable documents; a path that
  // doesn't resolve to a schema has no editor surface to synthesize.
  if (classification.kind !== "tracked") return null;
  // Tab names are the path basename, the stored name (tree `nameFromPath`
  // convention); the group's `documentName` is that same name.
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return {
    kind: "tracked",
    documentId: group.documentId,
    scheme,
    path,
    name: basename || (group.documentName ?? group.documentId),
    editable: true,
    filetype,
    schemaType: classification.schemaType,
    ...(group.draftOnly
      ? {
          reviews: {
            [group.workId]: { itemKey: group.itemKey, tabInstanceToken: crypto.randomUUID() },
          },
        }
      : {}),
  };
}
