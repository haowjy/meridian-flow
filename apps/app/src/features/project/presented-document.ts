/** The document the selected tab presents, and where: the Editor in Write, the dock beside Chat. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { createContext, useContext } from "react";
import { isDraftOnly, type ReviewPin, workIdOfReviewOwner, workReviewOwner } from "@/client/stores";
import type { OpenDocumentTab } from "./open-documents";
import type { ScreenKey } from "./shell/screens";

/** The route's verdict on an explicit review selector, asked of the server by `{ workId, itemKey }`. */
export type ReviewAddressAdmission = "pending" | "admitted" | "unavailable" | "failed";
/** A review by owner key (`work:<id>` today). Convert to and from a Work id only here. */
export type ReviewAddress = ReviewPin;

export function reviewAddress(workId: string, itemKey: string, changeId?: string): ReviewAddress {
  return { owner: workReviewOwner(workId), itemKey, ...(changeId ? { changeId } : {}) };
}

/** The Work whose branch holds the review; null for an owner that is not a Work. */
export function reviewAddressWorkId(address: ReviewAddress): string | null {
  return workIdOfReviewOwner(address.owner);
}
export type PresentedDocument = {
  container: "editor" | "dock";
  documentId: string | null;
  scheme: ProjectContextTreeScheme | null;
  path: string | null;
  review: ReviewAddress | null;
  /**
   * The tab asks for Draft: an open review of this document outlives its draft's row in the
   * Work's list, so the writer who applied the last change keeps that editor (its Undo, "No
   * changes left") until they choose Live.
   */
  draftView: boolean;
  draftOnly: boolean;
};

/**
 * The selected tab, presented where the screen puts it. The Work screen and the phone's Chat hold
 * no document.
 */
export function resolvePresentedDocument(input: {
  phone: boolean;
  screen: ScreenKey;
  selected: OpenDocumentTab | null;
}): PresentedDocument | null {
  const { selected, screen, phone } = input;
  if (!selected) return null;
  if (screen !== "context" && (screen !== "chat" || phone)) return null;
  const { tab } = selected;
  return {
    container: screen === "context" ? "editor" : "dock",
    documentId: tab.documentId,
    scheme: tab.kind === "new" ? null : tab.scheme,
    path: tab.kind === "new" ? null : tab.path,
    review: selected.review,
    draftView: selected.view.version === "draft",
    draftOnly: isDraftOnly(tab),
  };
}

export const PresentedDocumentContext = createContext<PresentedDocument | null>(null);
export const usePresentedDocument = () => useContext(PresentedDocumentContext);
