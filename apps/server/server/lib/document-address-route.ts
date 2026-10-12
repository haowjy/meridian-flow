/** Browser address admission validates review branch identity before selecting its draft tree. */
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import {
  type DocumentAddressResult,
  type DocumentAddressReviewSelector,
  folderDocumentName,
} from "@meridian/contracts/protocol";
import type { UserId, WorkId } from "@meridian/contracts/runtime";
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
    const segments = input.path.replace(/^\//u, "").split("/");
    segments[segments.length - 1] = folderDocumentName(segments.at(-1) ?? "");
    const path = segments.join("/");
    const matches = listed.items.filter((item) => {
      if (
        item.draftId !== listed.draftId ||
        item.draftBranchId !== review.draftBranchId ||
        (review.documentId !== undefined && item.documentId !== review.documentId) ||
        !item.path
      )
        return false;
      const uri = parseUnifiedContextUri(item.path);
      return uri.ok && uri.value.scheme === input.scheme && uri.value.path === path;
    });
    if (!listed.draftId || matches.length !== 1) return { kind: "unavailable" };
    reviewDocumentId = matches[0]?.documentId;
    view = { kind: "draft", draftId: listed.draftId };
    destination = { kind: "draft", workId: work.id, workSlug: work.isNoWork ? null : work.slug };
  }
  const resolved = await deps.documentAddresses.resolve({ ...input, view });
  if (resolved.kind === "unavailable") return resolved;
  if (reviewDocumentId && resolved.document.documentId !== reviewDocumentId)
    return { kind: "unavailable" };
  const principal = { accountId: input.userId as UserId };
  const target = { kind: "document" as const, documentId: resolved.document.documentId };
  const grant = destination
    ? await deps.fileAccess.authorizeAt(principal, target, destination, "read")
    : await deps.fileAccess.authorize(principal, target, "read");
  return isFileAccessDenied(grant) ? { kind: "unavailable" } : resolved;
}
