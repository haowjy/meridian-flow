/** Browser address admission validates the review item identity before selecting its draft tree. */
import type {
  DocumentAddressResult,
  DocumentAddressReviewSelector,
} from "@meridian/contracts/protocol";
import type { DocumentId, UserId, WorkId } from "@meridian/contracts/runtime";
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
  draftReview: Pick<DraftReviewApi, "items">;
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
    const work = await deps.workRepo.findById(review.workId as WorkId);
    if (!work || work.projectId !== input.projectId || work.deletedAt)
      return { kind: "unavailable" };
    const listed = await deps.draftReview.items({ workId: review.workId as WorkId });
    const matches = listed.items.filter(
      (item) => item.draftId === listed.draftId && item.itemKey === review.itemKey,
    );
    if (!listed.draftId || matches.length !== 1) return { kind: "unavailable" };
    reviewDocumentId = matches[0]?.documentId;
    view = { kind: "draft", draftId: listed.draftId };
    destination = { kind: "draft", workId: work.id, workSlug: work.isNoWork ? null : work.slug };
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
