import { useCallback, useEffect, useMemo, useRef } from "react";

import { navigateToPassage } from "@/core/editor/passage-navigation";
import { dismissPassageNotice, reportPassageChanged } from "@/core/editor/passage-notice-store";
import type { ContextPassageAnchor } from "@/features/chat/ChatContextNavigation";
import { LatestNavigationCoordinator } from "@/features/chat/latest-navigation-coordinator";
import type { OpenDocumentOutcome } from "@/features/project/context/open-project-document";

export type PassageDoors = {
  retire(): void;
  land(
    passage: ContextPassageAnchor,
    documentId: string,
    open: (signal: AbortSignal) => Promise<OpenDocumentOutcome>,
  ): void;
};

export function usePassageDoors(projectId: string, activeWorkId: string | null): PassageDoors {
  const coordinator = useRef(new LatestNavigationCoordinator());

  useEffect(() => {
    const scoped = coordinator.current;
    return () => scoped.dispose();
  }, [projectId, activeWorkId]);

  const retire = useCallback(() => {
    coordinator.current.dispose();
    dismissPassageNotice();
  }, []);

  const land = useCallback<PassageDoors["land"]>((passage, documentId, open) => {
    const landing = coordinator.current.run(async (signal) => {
      const result = await navigateToPassage({
        documentId,
        anchor: passage,
        signal,
        openDocument: () => open(signal),
      });
      if (signal.aborted) return;
      if (result.kind === "stale") reportPassageChanged(documentId);
    });
    void landing.catch(() => {});
  }, []);

  return useMemo(() => ({ retire, land }), [retire, land]);
}
