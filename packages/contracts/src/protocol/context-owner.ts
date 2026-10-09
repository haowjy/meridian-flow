/**
 * Who holds a Work-capable document: exclusive by type.
 *
 * A document is held by a Work (its row id, No Work's included) or, for
 * Scratch, by a No Work chat's lineage (the first chat's id). Never both. The
 * handle (`c12`) is what a lineage's URI spells; a query needs only the id, so
 * the handle is optional on a `ContextOwner` (a tab or placement carries it,
 * as `TabOwner` requires). Flatten to `workId` / `rootThreadId` only at the
 * HTTP and storage edges.
 */

/** A Work-scoped document's Work. `null` is for a project scheme, which has no owner. */
export type WorkOwnerRef = {
  workId?: string | null;
  rootThreadId?: undefined;
  rootThreadRef?: undefined;
};

/** A chat's Scratch, by the first chat's id and, when known, the handle its URI spells. */
export type LineageOwnerRef = {
  workId?: undefined;
  rootThreadId: string;
  rootThreadRef?: string;
};

/** Enough to ask for a catalog, a document or a request. */
export type ContextOwner = WorkOwnerRef | LineageOwnerRef;

/** The owner two separate nullable pieces name: the lineage when there is one, else the Work. */
export function contextOwner(
  workId: string | null | undefined,
  rootThreadId?: string | null,
): ContextOwner {
  return rootThreadId ? { rootThreadId } : { workId: workId ?? null };
}

/** A lineage as the writer names it: the first chat's handle and title, which survive its trash. */
export type LineageInfo = {
  rootThreadId: string;
  rootThreadRef: string;
  title: string | null;
};
