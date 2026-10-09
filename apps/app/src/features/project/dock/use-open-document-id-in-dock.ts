/**
 * Opens a document known only by id (a Recent row) where the writer is: the
 * dock's document slot on the Chat screen, and wherever `useOpenDocumentInDock`
 * sends it elsewhere. The id resolves to its scheme and owner (Work, lineage or
 * project area) from the resource replica, then the server, with nothing
 * navigating until the document is known.
 */
import { t } from "@lingui/core/macro";
import { useCallback } from "react";
import { announceError } from "@/client/stores";
import { serverTabFromFile } from "../context/context-tab-from-file";
import { useLocateProjectDocument } from "../context/open-project-document";
import { useDockViewStore } from "./dock-view-store";
import { useOpenDocumentInDock } from "./use-open-document-in-dock";

export function useOpenDocumentIdInDock(projectId: string) {
  const locate = useLocateProjectDocument(projectId);
  const openInDock = useOpenDocumentInDock();
  return useCallback(
    async (documentId: string) => {
      // A slow lookup must not replace what the writer chose since: any change
      // to the dock's occupant while it ran means it stands down.
      const { revision } = useDockViewStore.getState();
      const located = await locate(documentId);
      if (useDockViewStore.getState().revision !== revision || located.kind === "cancelled") return;
      const tab =
        located.kind === "located"
          ? serverTabFromFile(located.scheme, located.file, located.owner)
          : null;
      if (!tab) {
        announceError(t`Couldn’t open this document.`);
        return;
      }
      openInDock(tab);
    },
    [locate, openInDock],
  );
}
