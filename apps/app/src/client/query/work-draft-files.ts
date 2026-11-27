import { documentTitleFromUri } from "@meridian/contracts/context-uri";
import type { DraftItem } from "@meridian/contracts/drafts";
import { readSegment } from "@meridian/contracts/protocol";
import type { TreeView } from "@/core/project-tree/tree-view";
import type { ContextUri } from "@/lib/context-uri";
import { parseContextUri } from "@/lib/context-uri";

export type ReviewFileTarget = {
  documentId: string;
  documentName: string | null;
  contextLocation: Pick<ContextUri, "scheme" | "path"> | null;
  item: DraftItem;
  draftOnly: boolean;
};

export function projectWorkDraftFiles(
  items: readonly DraftItem[],
  tree: Pick<TreeView, "findDocument"> | null,
): ReviewFileTarget[] {
  return sortDraftFiles(
    items.map((item) => {
      const live = tree?.findDocument(item.documentId);
      const location = live ? parseContextUri(live.uri) : null;
      // Until the tree answers, a document the draft moves is live where it was, not at the
      // draft's new path: opening it there would land on an address nothing holds yet.
      const movedFrom = item.tree?.movedFrom;
      return {
        documentId: item.documentId,
        // The item owns a drafted move's current identity. The live tree still names the
        // old location until Apply, but review surfaces must agree with the open draft editor.
        documentName: movedFrom
          ? item.documentName
          : live
            ? (documentTitleFromUri(live.uri) ?? item.documentName)
            : item.documentName,
        contextLocation: location
          ? { scheme: location.scheme, path: location.path }
          : (movedFrom ?? item.contextLocation),
        item,
        draftOnly: item.isNew,
      };
    }),
  );
}

export function sortDraftFiles<
  T extends {
    documentId: string;
    documentName: string | null;
    contextLocation: Pick<ContextUri, "scheme" | "path"> | null;
  },
>(files: readonly T[]): T[] {
  const key = (file: T) =>
    (
      file.documentName ??
      documentBasename(file.contextLocation?.path) ??
      file.documentId
    ).toLowerCase();
  return [...files].sort(
    (left, right) =>
      key(left).localeCompare(key(right)) || left.documentId.localeCompare(right.documentId),
  );
}

export function documentBasename(contextPath: string | null | undefined): string | null {
  if (!contextPath) return null;
  const trimmed = contextPath.replace(/\/+$/, "");
  const base = readSegment(trimmed.slice(trimmed.lastIndexOf("/") + 1)).name;
  return base.length > 0 ? base : null;
}

export function reviewFileTargetName(row: ReviewFileTarget, untitled: string): string {
  return (
    row.documentName ??
    (row.draftOnly ? (documentBasename(row.contextLocation?.path) ?? untitled) : row.documentId)
  );
}
