/** A plain address never acquires a review's authority to read a hidden document. */
import type {
  DocumentAddressRequestOptions,
  DocumentAddressResult,
} from "@meridian/contracts/protocol";

import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import type { ContextRouteSelection } from "../context/context-removal-protocol";
import type { ProjectDestination } from "./project-address";

export type DocumentAddressBinding =
  | { kind: "plain" }
  | { kind: "pending" | "failed" | "unavailable" }
  | {
      kind: "review";
      review: NonNullable<DocumentAddressRequestOptions["review"]> & { documentId: string };
    };

/** The branch owns review identity even while its Work's draft list is loading. */
export function bindDocumentAddressReview(
  draftId: string | undefined,
  workId: string | null,
  drafts: { status: string; groups: ThreadDraftGroup[] | null },
): DocumentAddressBinding {
  if (!draftId) return { kind: "plain" };
  if (!workId || drafts.status === "loading") return { kind: "pending" };
  if (drafts.status === "error") return { kind: "failed" };
  const group = drafts.groups?.find((candidate) => candidate.draft.draftId === draftId);
  return group
    ? { kind: "review", review: { workId, draftBranchId: draftId, documentId: group.documentId } }
    : { kind: "unavailable" };
}

/** A failed review selector never falls back to the live occupant. */
export function reviewBoundAddressResult(
  binding: DocumentAddressBinding,
  remote: DocumentAddressResult | undefined,
): DocumentAddressResult | undefined {
  if (binding.kind === "unavailable") return { kind: "unavailable" };
  if (binding.kind === "pending" || binding.kind === "failed") return undefined;
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
    result.document.documentId !== binding.review.documentId ||
    !destination ||
    selection.status === "none" ||
    workId !== binding.review.workId ||
    selection.locator.workId !== workId ||
    selection.locator.scheme !== destination.scheme ||
    selection.locator.path.replace(/^\/+/, "") !== destination.path.replace(/^\/+/, "") ||
    (selection.status === "bound" &&
      selection.identity.kind === "server" &&
      selection.identity.documentId === binding.review.documentId)
  )
    return null;
  return { revision: selection.revision, documentId: binding.review.documentId };
}
