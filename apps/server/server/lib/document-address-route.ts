/** Browser address admission validates the review item identity before selecting its branch tree. */

import { draftOwnerFromKey, draftOwnerKey } from "@meridian/contracts";
import type {
  DocumentAddressResult,
  DocumentAddressReviewSelector,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";
import type { DraftReviewApi } from "../domains/collab/contracts.js";
import type {
  DocumentAddressInput,
  DocumentAddressResolver,
} from "../domains/context/ports/document-address.js";
import {
  type FileAccess,
  type FileDestination,
  isFileAccessDenied,
} from "../domains/file-policy/index.js";
import type { AppServices } from "./compose.js";

type AddressRouteServices = {
  documentAddresses: DocumentAddressResolver;
  workRepo: Pick<AppServices["workRepo"], "findById">;
  draftReview: Pick<DraftReviewApi, "resolveItem" | "branchOwner">;
  fileAccess: Pick<FileAccess, "authorize" | "authorizeAt">;
};

export async function handleDocumentAddressRequest(
  deps: AddressRouteServices,
  input: Omit<DocumentAddressInput, "view">,
  review?: DocumentAddressReviewSelector,
): Promise<DocumentAddressResult> {
  let view: DocumentAddressInput["view"];
  let destination: FileDestination | undefined;
  let reviewDocumentId: string | undefined;
  if (review) {
    const owner = draftOwnerFromKey(review.owner, input.projectId as ProjectId);
    if (!owner) return { kind: "unavailable" };
    let handle: string | null = null;
    if (owner.kind === "work") {
      const work = await deps.workRepo.findById(owner.workId);
      if (!work || work.projectId !== input.projectId || work.deletedAt)
        return { kind: "unavailable" };
      handle = work.isNoWork ? null : work.handle;
    }
    // Addressable, not listed: an unlisted active item opens too (M1). A bare draft id,
    // another Work's key and a `branches.id` all resolve to nothing here.
    const resolved = await deps.draftReview.resolveItem({ itemKey: review.itemKey });
    // The key's branch must be this owner's, as the selector says.
    const branch = resolved && (await deps.draftReview.branchOwner(resolved.branchId));
    if (
      !resolved ||
      !branch?.owner ||
      draftOwnerKey(branch.owner) !== draftOwnerKey(owner) ||
      branch.branch.projectId !== input.projectId
    )
      return { kind: "unavailable" };
    reviewDocumentId = resolved.documentId;
    // A drafted delete is intentionally absent from its branch tree. The validated review
    // identity still opens the live document at the item's path; ordinary path resolution
    // remains unavailable in that branch.
    view = resolved.item.tree?.deleted
      ? { kind: "live" }
      : { kind: "branch", branchId: resolved.branchId };
    destination = { kind: "draft", owner, ownerHandle: handle };
  }
  const principal = { accountId: input.userId as UserId };
  if (destination && reviewDocumentId) {
    const grant = await deps.fileAccess.authorizeAt(
      principal,
      { kind: "document", documentId: reviewDocumentId },
      destination,
      "read",
    );
    if (isFileAccessDenied(grant)) return { kind: "unavailable" };
  }
  const resolved = reviewDocumentId
    ? await deps.documentAddresses.resolveById({
        projectId: input.projectId,
        userId: input.userId,
        documentId: reviewDocumentId as DocumentId,
        view,
      })
    : await deps.documentAddresses.resolve(input);
  if (resolved.kind === "unavailable") return resolved;
  if (reviewDocumentId && resolved.document.documentId !== reviewDocumentId)
    return { kind: "unavailable" };
  if (destination) return resolved;
  const target = { kind: "document" as const, documentId: resolved.document.documentId };
  const grant = await deps.fileAccess.authorize(principal, target, "read");
  return isFileAccessDenied(grant) ? { kind: "unavailable" } : resolved;
}
