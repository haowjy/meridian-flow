/** Opens an already-materialized Work file in the Editor destination. */
import { useCallback } from "react";
import type { ContextTab } from "@/client/stores";
import { useOpenContextRoute } from "./ProjectNavigationContext";

export function useOpenWorkFileInEditor(workId: string) {
  const openContextRoute = useOpenContextRoute();
  return useCallback(
    (tab: Extract<ContextTab, { kind: "viewer" }>) => {
      if (!openContextRoute) return;
      void openContextRoute({ scheme: tab.scheme, path: tab.path, workId }, { replace: false });
    },
    [openContextRoute, workId],
  );
}
