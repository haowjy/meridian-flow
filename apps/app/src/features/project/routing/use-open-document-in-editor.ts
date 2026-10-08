/** Opens an already-materialized document in the Editor destination. */
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useCallback } from "react";
import { useOpenContextRoute } from "./ProjectNavigationContext";

export function useOpenDocumentInEditor() {
  const openContextRoute = useOpenContextRoute();
  return useCallback(
    (target: { scheme: ProjectContextTreeScheme; path: string } & ContextOwner) => {
      if (!openContextRoute) return;
      void openContextRoute(
        {
          scheme: target.scheme,
          path: target.path,
          workId: target.workId ?? undefined,
          ...(target.rootThreadId ? { rootThreadId: target.rootThreadId } : {}),
        },
        { replace: false },
      );
    },
    [openContextRoute],
  );
}
