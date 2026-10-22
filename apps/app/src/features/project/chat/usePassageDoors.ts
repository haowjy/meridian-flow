/** Project-route composition for passage doors: opens the resolved document, lands on the anchor, and retires it when a newer intent begins. */
import { useCallback, useEffect, useMemo, useRef } from "react";

import { navigateToPassage } from "@/core/editor/passage-navigation";
import { dismissPassageNotice, reportPassageChanged } from "@/core/editor/passage-notice-store";
import type { ContextPassageAnchor } from "@/features/chat/ChatContextNavigation";
import { LatestNavigationCoordinator } from "@/features/chat/latest-navigation-coordinator";
import { useOpenChatDocument } from "@/features/project/context/open-chat-document";

/** The document the resolver named, and the dock claim the door took when it was clicked. */
export type PassageDoorResolved = { documentId: string; claim?: number };

export type PassageDoors = {
  /** A newer intent (any door, any transcript link) retires a passage still landing, and its notice. */
  retire(): void;
  /**
   * Open the resolved document and land on the anchor. The open starts now, inside the
   * follower's answer, so it is the chat's current intent; the open result decides whether
   * the passage can land.
   */
  land(workId: string | null, passage: ContextPassageAnchor, resolved: PassageDoorResolved): void;
};

export function usePassageDoors(projectId: string, activeWorkId: string | null): PassageDoors {
  const coordinator = useRef(new LatestNavigationCoordinator());
  const openDocument = useOpenChatDocument(projectId);

  // A landing belongs to the scope it began in. Changing project or work retires it
  // exactly as a newer door would.
  useEffect(() => {
    const scoped = coordinator.current;
    return () => scoped.dispose();
  }, [projectId, activeWorkId]);

  const retire = useCallback(() => {
    // The previous door's answer stops being true the moment another intent begins,
    // and that includes its notice.
    coordinator.current.dispose();
    dismissPassageNotice();
  }, []);

  const land = useCallback<PassageDoors["land"]>(
    (workId, passage, resolved) => {
      const landing = coordinator.current.run(async (signal) => {
        const result = await navigateToPassage({
          documentId: resolved.documentId,
          anchor: passage,
          signal,
          openDocument: (documentId) =>
            openDocument({
              documentId,
              workId: workId ?? undefined,
              signal,
              claim: resolved.claim,
            }),
        });
        // Report only while this door is still the writer's latest: a stale
        // verdict about somewhere they have already left is worse than silence.
        if (signal.aborted) return;
        if (result.kind === "stale") reportPassageChanged(resolved.documentId);
      });
      // Passage landing is best effort: the document is the door's real promise.
      void landing.catch(() => {});
    },
    [openDocument],
  );

  return useMemo(() => ({ retire, land }), [retire, land]);
}
