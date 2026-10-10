/** The Work draft list's catalog-labelled file projection and stable file order. */
import { documentTitleFromUri } from "@meridian/contracts/context-uri";
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import type { CatalogContextView } from "./context-catalog-projection";

/** One document's active draft, as a file in a list of the Work's drafts. */
export type ReviewFileTarget = {
  documentId: string;
  documentName: string | null;
  contextPath: string | null;
  /** The active draft the row's verbs act on. */
  draft: ThreadDraftListItem;
  /** Absent from the live project until Apply. */
  isNewDocument: boolean;
};

/** The DB guarantees one active draft per document/Work; raw rows remain untouched. */
export function projectWorkDraftFiles(
  drafts: readonly ThreadDraftListItem[],
  catalog: Pick<CatalogContextView, "findDocument"> | null,
): ReviewFileTarget[] {
  return sortDraftFiles(
    drafts
      .filter((draft) => draft.status === "active")
      .map((draft) => {
        const live = catalog?.findDocument(draft.documentId);
        return {
          documentId: draft.documentId,
          documentName: live
            ? (documentTitleFromUri(live.uri) ?? draft.documentName)
            : draft.documentName,
          contextPath: live ? live.path : draft.contextPath,
          draft,
          isNewDocument: draft.isNewDocument === true,
        };
      }),
  );
}

/**
 * The one order every list of draft files uses (the composer strip, the Work
 * page's Changes to review, and "Next draft"): by the
 * name each file is shown under, then by id. Drafts carry no creation time and
 * an update time would reshuffle the list as the AI keeps writing, so a file
 * keeps its place until its name changes.
 */
export function sortDraftFiles<
  T extends { documentId: string; documentName: string | null; contextPath: string | null },
>(files: readonly T[]): T[] {
  const key = (file: T) =>
    (file.documentName ?? documentBasename(file.contextPath) ?? file.documentId).toLowerCase();
  return [...files].sort(
    (left, right) =>
      key(left).localeCompare(key(right)) || left.documentId.localeCompare(right.documentId),
  );
}

/**
 * The basename of a document's context path (`work://drafts/ch-3.md` → `ch-3.md`),
 * or `null` when there's no usable path. New documents are URI-addressed, so the
 * basename is the display name when the AI created the doc unnamed (spec §5.5,
 * product call 2026-07-05). Trailing slashes are ignored.
 */
export function documentBasename(contextPath: string | null | undefined): string | null {
  if (!contextPath) return null;
  const trimmed = contextPath.replace(/\/+$/, "");
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return base.length > 0 ? base : null;
}
