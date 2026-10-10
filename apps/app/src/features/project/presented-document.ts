/** The current container's address, independent of collapse and retained Editor paint. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { createContext, useContext } from "react";
import type { DockDocument } from "./dock/dock-document-store";
import type { ScreenKey } from "./shell/screens";

export type ReviewAddress = { workId: string; draftId: string };
export type PresentedDocument = {
  container: "editor" | "dock";
  documentId: string | null;
  scheme: ProjectContextTreeScheme | null;
  path: string | null;
  review: ReviewAddress | null;
  draftOnly: boolean;
};

export function resolvePresentedDocument(input: {
  phone: boolean;
  screen: ScreenKey;
  editor: {
    workId: string | null;
    scheme: ProjectContextTreeScheme | null;
    path: string | null;
    documentId?: string | null;
    draftId?: string;
    draftOnly: boolean;
  };
  dock: DockDocument | null;
}): PresentedDocument | null {
  if (input.screen === "context") {
    const editor = input.editor;
    return {
      container: "editor",
      documentId: editor.documentId ?? null,
      scheme: editor.scheme,
      path: editor.path,
      draftOnly: editor.draftOnly,
      review:
        editor.workId && editor.draftId ? { workId: editor.workId, draftId: editor.draftId } : null,
    };
  }
  if (input.phone || !input.dock) return null;
  const { tab, review } = input.dock;
  return {
    container: "dock",
    documentId: tab.documentId,
    scheme: tab.kind === "new" ? null : tab.scheme,
    path: tab.kind === "new" ? null : tab.path,
    review,
    draftOnly: tab.kind === "tracked" && tab.draftOnly === true,
  };
}

export const PresentedDocumentContext = createContext<PresentedDocument | null>(null);
export const usePresentedDocument = () => useContext(PresentedDocumentContext);
