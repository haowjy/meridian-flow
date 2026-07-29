/** Project-route composition for change-trail navigation. */
import { useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { listProjectThreads } from "@/client/api/projects-api";
import type { TrailChange } from "@/client/change-trails";
import { navigateToTrailChange } from "@/core/editor/change-trail-navigation";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";
import { LatestNavigationCoordinator } from "./latest-navigation-coordinator";

export type NavigateToTrailChange = ReturnType<typeof useChangeTrailNavigation>;

export function useChangeTrailNavigation(threadId: string) {
  const { projectId } = useParams({ strict: false }) as { projectId?: string };
  const openDocument = useOpenProjectDocument(projectId);
  const coordinator = useRef(new LatestNavigationCoordinator());
  useEffect(() => () => coordinator.current.dispose(), []);

  return useCallback(
    (documentId: string, change: TrailChange) => {
      return coordinator.current.run((signal) =>
        navigateToTrailChange({
          documentId,
          change,
          signal,
          openDocument: async () => {
            if (!projectId) return false;
            // The thread's work is what makes its scratch documents reachable;
            // a trail may point at one.
            const thread = (await listProjectThreads(projectId)).find(
              (item) => item.id === threadId,
            );
            if (signal.aborted) return false;
            return openDocument({ documentId, workId: thread?.workId ?? null, signal });
          },
        }),
      );
    },
    [openDocument, projectId, threadId],
  );
}
