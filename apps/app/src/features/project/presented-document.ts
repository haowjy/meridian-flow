/** The document the selected tab presents, and where: the Editor in Write, the dock beside Chat. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { createContext, useContext } from "react";
import { isDraftOnly } from "@/client/stores";
import type { OpenDocumentTab } from "./open-documents";
import type { ScreenKey } from "./shell/screens";

/** The route's verdict on an explicit review selector, asked of the server by `{ workId, itemKey }`. */
export type ReviewAddressAdmission = "pending" | "admitted" | "unavailable" | "failed";
export type ReviewAddress = { workId: string; itemKey: string; changeId?: string };
export type PresentedDocument = {
  container: "editor" | "dock";
  documentId: string | null;
  scheme: ProjectContextTreeScheme | null;
  path: string | null;
  review: ReviewAddress | null;
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
    draftOnly: isDraftOnly(tab),
  };
}

export const PresentedDocumentContext = createContext<PresentedDocument | null>(null);
export const usePresentedDocument = () => useContext(PresentedDocumentContext);
