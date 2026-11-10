/** A plain address never acquires a review's authority to read a hidden document. */
import { draftOwnerKey } from "@meridian/contracts/branches";
import type {
  ContextOwner,
  DocumentAddressRequestOptions,
  DocumentAddressResult,
} from "@meridian/contracts/protocol";

import { queryOptions } from "@tanstack/react-query";
import type { getProjectDocumentAddress } from "@/client/api/projects-api";
import { projectReadEnabled } from "@/client/creation/project-read-gate";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  type ContextRouteSelection,
  type RouteBindingProof,
  selectionAtRoute,
} from "../context/context-removal-protocol";
import type { ProjectDestination } from "./project-address";

export type DocumentAddressBinding =
  | { kind: "plain" }
  | { kind: "pending" }
  | {
      kind: "review";
      review: NonNullable<DocumentAddressRequestOptions["review"]>;
    };

/**
 * Whose draft an address with an item reviews: the lineage its `chat` names, else the address's
 * Work. Null while the Work is unresolved, or when the address names no item.
 */
export function addressReviewOwner(
  address: { itemKey?: string; lineage?: string },
  workId: string | null,
): string | null {
  if (!address.itemKey) return null;
  if (address.lineage) return draftOwnerKey({ kind: "lineage", rootThreadId: address.lineage });
  return workId ? draftOwnerKey({ kind: "work", workId }) : null;
}

/** The item owns review identity even while its owner's draft list is loading. */
export function bindDocumentAddressReview(
  itemKey: string | undefined,
  owner: string | null,
): DocumentAddressBinding {
  if (!itemKey) return { kind: "plain" };
  if (!owner) return { kind: "pending" };
  return { kind: "review", review: { owner, itemKey } };
}

/** A failed review selector never falls back to the live occupant. */
export function reviewBoundAddressResult(
  binding: DocumentAddressBinding,
  remote: DocumentAddressResult | undefined,
): DocumentAddressResult | undefined {
  if (binding.kind === "pending") return undefined;
  return remote;
}

/**
 * The one way an address answer binds the route. A review's answer is authoritative for its
 * item and rebinds a selection bound to another document. A plain answer binds only a candidate:
 * a bound selection was proven by a navigation that named its document or by an earlier answer.
 */
export function addressRouteBinding(
  binding: DocumentAddressBinding,
  result: DocumentAddressResult | undefined,
  selection: ContextRouteSelection,
  destination: Extract<ProjectDestination, { kind: "document" }> | null,
  workId: string | null,
  rootThreadId: string | undefined,
  /** The owner the address reviews (`addressReviewOwner`); null when it names none. */
  reviewOwner?: string | null,
): { revision: number; documentId: string; by: RouteBindingProof } | null {
  if (
    binding.kind === "pending" ||
    !result ||
    result.kind === "unavailable" ||
    !destination ||
    workId === null ||
    !selectionAtRoute(selection, {
      scheme: destination.scheme,
      path: destination.path,
      workId,
      rootThreadId,
    })
  )
    return null;
  const { documentId } = result.document;
  if (binding.kind === "review") {
    if (
      reviewOwner !== binding.review.owner ||
      (selection.status === "bound" &&
        selection.identity.kind === "server" &&
        selection.identity.documentId === documentId)
    )
      return null;
  } else if (selection.status !== "candidate") return null;
  return {
    revision: selection.revision,
    documentId,
    by: binding.kind === "review" ? "review" : "answer",
  };
}

/** The address read starts independently of list/catalog acquisition; its key owns the selector. */
export function documentAddressQueryOptions(
  input: {
    projectId: string;
    destination: Extract<ProjectDestination, { kind: "document" }> | null;
    owner: ContextOwner;
    binding: DocumentAddressBinding;
    workResolved: boolean;
  },
  read: typeof getProjectDocumentAddress,
) {
  const review = input.binding.kind === "review" ? input.binding.review : undefined;
  return queryOptions({
    queryKey: [
      ...projectQueryKeys.documentAddresses(input.projectId),
      input.destination?.scheme,
      input.destination?.path,
      input.owner.rootThreadId ?? input.owner.workId,
      review?.owner,
      review?.itemKey,
    ],
    queryFn: () => {
      if (!input.destination || input.binding.kind === "pending")
        throw new Error("Document address is unresolved");
      return read(input.projectId, input.destination.scheme, input.destination.path, {
        ...input.owner,
        ...(review ? { review } : {}),
      });
    },
    enabled: projectReadEnabled(
      !!input.destination && input.workResolved && input.binding.kind !== "pending",
    ),
    staleTime: 0,
    // A review's answer names another key's path and is only true while the draft's move
    // stands. Kept past its key, two such answers point at each other and the URL loops.
    ...(review ? { gcTime: 0 } : {}),
    retry: false,
  });
}
