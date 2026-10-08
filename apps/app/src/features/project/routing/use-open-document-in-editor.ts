/** Opens an already-materialized document in the Editor destination. */
import { useCallback } from "react";
import type { ServerContextTab } from "@/client/stores";
import { useOpenContextRoute } from "./ProjectNavigationContext";

export function useOpenDocumentInEditor() {
  const openContextRoute = useOpenContextRoute();
  return useCallback(
    (tab: ServerContextTab) => {
      if (!openContextRoute) return;
      void openContextRoute(
        { scheme: tab.scheme, path: tab.path, workId: tab.workId },
        { replace: false },
      );
    },
    [openContextRoute],
  );
}
