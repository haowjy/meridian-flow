/** A plain address never acquires a review's authority to read a hidden document. */
import type {
  ContextOwner,
  DocumentAddressRequestOptions,
  DocumentAddressResult,
} from "@meridian/contracts/protocol";

import { queryOptions } from "@tanstack/react-query";
import type { getProjectDocumentAddress } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import type { ContextRouteSelection } from "../context/context-removal-protocol";
import type { ProjectDestination } from "./project-address";

export type DocumentAddressBinding =
  | { kind: "plain" }
  | { kind: "pending" }
  | {
      kind: "review";
      review: NonNullable<DocumentAddressRequestOptions["review"]>;
    };

/** The item owns review identity even while its Work's draft list is loading. */
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

/** The address read starts independently of list/catalog acquisition; its key owns the selector. */
export function documentAddressQueryOptions(
  input: {
    projectId: string;
    destination: Extract<ProjectDestination, { kind: "document" }> | null;
    owner: ContextOwner;
    binding: DocumentAddressBinding;
    workResolved: boolean;
    catalogGeneration?: string;
    catalogRevision?: string;
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
      review?.workId,
      review?.itemKey,
      input.catalogGeneration,
      input.catalogRevision,
    ],
    queryFn: () => {
      if (!input.destination || input.binding.kind === "pending")
        throw new Error("Document address is unresolved");
      return read(input.projectId, input.destination.scheme, input.destination.path, {
        ...input.owner,
        ...(review ? { review } : {}),
      });
    },
    enabled: !!input.destination && input.workResolved && input.binding.kind !== "pending",
    staleTime: 0,
    retry: false,
  });
}
