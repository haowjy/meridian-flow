/** A draft's items as tree-labelled files, and the stable file order. */

import { documentTitleFromUri } from "@meridian/contracts/context-uri";
import type { DraftItem } from "@meridian/contracts/drafts";
import { readSegment } from "@meridian/contracts/protocol";
import type { TreeView } from "@/core/project-tree/tree-view";
import type { ContextUri } from "@/lib/context-uri";
import { parseContextUri } from "@/lib/context-uri";

/** One item of a draft, as a file in the draft's list of documents. */
export type ReviewFileTarget = {
  documentId: string;
  documentName: string | null;
  contextLocation: Pick<ContextUri, "scheme" | "path"> | null;
  /** The item the row's verbs act on. */
  item: DraftItem;
  /** Absent from the live project until Apply: a document the draft created. */
  draftOnly: boolean;
};

/** Each item labelled by the tree, in the one file order; raw rows remain untouched. */
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

/**
 * The one order every list of draft files uses (the composer strip, the
 * sidebar's Changes tab, and "Next document"): by the
 * name each file is shown under, then by id. Draft list rows carry no creation time and
 * an update time would reshuffle the list as the AI keeps writing, so a file
 * keeps its place until its name changes.
 */
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

/**
 * The basename of a document's context path (`manuscript://book/ch-3.md` → `ch-3.md`),
 * or `null` when there's no usable path. New documents are URI-addressed, so the
 * basename is the display name when the AI created the doc unnamed (spec §5.5,
 * product call 2026-07-05). Trailing slashes are ignored.
 */
export function documentBasename(contextPath: string | null | undefined): string | null {
  if (!contextPath) return null;
  const trimmed = contextPath.replace(/\/+$/, "");
  const base = readSegment(trimmed.slice(trimmed.lastIndexOf("/") + 1)).name;
  return base.length > 0 ? base : null;
}
