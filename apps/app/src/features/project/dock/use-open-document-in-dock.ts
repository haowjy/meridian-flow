/**
 * Opens a known file from the dock's own title menu or a path pick: beside the chat where the
 * dock holds a document (wide Chat), and in the Editor where it does not (see `use-dock-placement`).
 */
import { useCallback } from "react";
import type { ServerContextTab } from "@/client/stores";
import { useOpenContextRoute } from "../routing/ProjectNavigationContext";
import { useDockPlacement } from "./use-dock-placement";

export function useOpenDocumentInDock() {
  const placement = useDockPlacement();
  const openContextRoute = useOpenContextRoute();
  return useCallback(
    (tab: ServerContextTab) => {
      if (placement.besideChat) {
        placement.commit(tab);
        return;
      }
      void openContextRoute?.(
        {
          scheme: tab.scheme,
          path: tab.path,
          workId: tab.workId,
          documentId: tab.documentId,
          ...(tab.rootThreadId ? { rootThreadId: tab.rootThreadId } : {}),
        },
        { replace: false },
      );
    },
    [openContextRoute, placement],
  );
}
