/**
 * Opens a known file from Work Files or the dock's own title menu: in the dock
 * where it holds a document (Chat and Work), and in the Editor where it does not
 * (the Editor screen, which opens tabs, and the phone, whose documents open
 * full-screen). See `use-dock-placement` for the placement rules.
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
      if (placement.holdsDocument) {
        placement.commit(tab);
        return;
      }
      void openContextRoute?.(
        {
          scheme: tab.scheme,
          path: tab.path,
          workId: tab.workId,
          ...(tab.rootThreadId ? { rootThreadId: tab.rootThreadId } : {}),
        },
        { replace: false },
      );
    },
    [openContextRoute, placement],
  );
}
