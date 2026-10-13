/** A plain address never acquires a review's authority to read a hidden document. */
import type {
  DocumentAddressRequestOptions,
  DocumentAddressResult,
} from "@meridian/contracts/protocol";

import type { ContextRouteSelection } from "../context/context-removal-protocol";
import type { ProjectDestination } from "./project-address";

export type DocumentAddressBinding =
  | { kind: "plain" }
  | { kind: "pending" }
  | {
      kind: "review";
      review: NonNullable<DocumentAddressRequestOptions["review"]>;
    };

/** The branch owns review identity even while its Work's draft list is loading. */
export function bindDocumentAddressReview(
  itemKey: string | undefined,
  workId: string | null,
): DocumentAddressBinding {
  if (!itemKey) return { kind: "plain" };
  if (!workId) return { kind: "pending" };
  return { kind: "review", review: { workId, itemKey } };
}

/** A failed review selector never falls back to the live occupant. */
export function reviewBoundAddressResult(
  binding: DocumentAddressBinding,
  remote: DocumentAddressResult | undefined,
): DocumentAddressResult | undefined {
  if (binding.kind === "pending") return undefined;
  return remote;
}

/** Server-admitted review identity also owns the pane, not just the address query. */
export function reviewAddressRouteBinding(
  binding: DocumentAddressBinding,
  result: DocumentAddressResult | undefined,
  selection: ContextRouteSelection,
  destination: Extract<ProjectDestination, { kind: "document" }> | null,
  workId: string | null,
): { revision: number; documentId: string } | null {
  if (
    binding.kind !== "review" ||
    !result ||
    result.kind === "unavailable" ||
    !destination ||
    selection.status === "none" ||
    workId !== binding.review.workId ||
    selection.locator.workId !== workId ||
    selection.locator.scheme !== destination.scheme ||
    selection.locator.path.replace(/^\/+/, "") !== destination.path.replace(/^\/+/, "") ||
    (selection.status === "bound" &&
      selection.identity.kind === "server" &&
      selection.identity.documentId === result.document.documentId)
  )
    return null;
  return { revision: selection.revision, documentId: result.document.documentId };
}
