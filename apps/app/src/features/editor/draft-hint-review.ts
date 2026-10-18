/**
 * The two places a document's draft hint still depends on a draft coming from a Work: which
 * hints the current view already shows as its own draft, and the review address a hint opens
 * (today's address names the origin Work). When branches are chosen independently of Works,
 * this file is what changes.
 */
import type { DocumentDraftHint } from "@meridian/contracts/branches";
import type { AiDraftLaunchTarget } from "@/features/project/dock/editor-review-handoff";
import type { ContextUri } from "@/lib/context-uri";

/** The hints the view is not already working in: its own Work's draft has the existing chip. */
export function branchesOtherThanViews(
  hints: readonly DocumentDraftHint[],
  viewWorkId: string,
): DocumentDraftHint[] {
  return hints.filter((hint) => hint.originWorkId !== viewWorkId);
}

/** Where Review goes for a hint; null when its draft has no Work to address the review by. */
export function hintReviewTarget(
  hint: DocumentDraftHint,
  document: {
    documentId: string;
    contextLocation: Pick<ContextUri, "scheme" | "path">;
    documentName?: string;
  },
): AiDraftLaunchTarget | null {
  if (!hint.originWorkId) return null;
  return {
    workId: hint.originWorkId,
    documentId: document.documentId,
    itemKey: hint.itemKey,
    contextLocation: document.contextLocation,
    ...(document.documentName ? { documentName: document.documentName } : {}),
  };
}
