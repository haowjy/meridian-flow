/**
 * The two places a document's draft hint reads a branch's owner: which hints the current view
 * already shows as its own draft, and the review address a hint opens.
 */
import type { DocumentDraftHint } from "@meridian/contracts/branches";
import type { AiDraftLaunchTarget } from "@/features/project/dock/editor-review-handoff";
import type { ContextUri } from "@/lib/context-uri";

/** The hints the view is not already working in: its own owner's draft has the existing chip. */
export function branchesOtherThanViews(
  hints: readonly DocumentDraftHint[],
  viewOwnerKey: string,
): DocumentDraftHint[] {
  return hints.filter((hint) => hint.owner !== viewOwnerKey);
}

/** Where Review goes for a hint. */
export function hintReviewTarget(
  hint: DocumentDraftHint,
  document: {
    documentId: string;
    contextLocation: Pick<ContextUri, "scheme" | "path">;
    documentName?: string;
  },
): AiDraftLaunchTarget {
  return {
    ownerKey: hint.owner,
    documentId: document.documentId,
    itemKey: hint.itemKey,
    contextLocation: document.contextLocation,
    ...(document.documentName ? { documentName: document.documentName } : {}),
  };
}
