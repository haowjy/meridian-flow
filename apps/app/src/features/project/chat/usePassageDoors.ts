/**
 * Project-route composition for document doors: what happens to passage state
 * every time the writer opens one.
 *
 * **Every door reports here, passage or not.** A door is the moment the writer
 * changes their mind about where they are, and that has to retire whatever the
 * last door was still resolving — otherwise a slow passage lookup lands a
 * highlight, or raises "that passage changed", in a document the writer left
 * two clicks ago. Making only passage doors visible to the coordinator left
 * ordinary doors unable to cancel anything, and let a stale notice sit under a
 * later, perfectly good landing.
 *
 * Routing is not this hook's job: the door has already made it, and the
 * document opens whether or not the passage survives. What is left is
 * resolving the path to a document id (the tree is the only place that mapping
 * lives), handing the anchor to the editor runtime, and reporting the one
 * outcome the writer needs to hear about.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useCallback, useEffect, useRef } from "react";

import { getProjectContextTree } from "@/client/api/projects-api";
import { navigateToPassage } from "@/core/editor/passage-navigation";
import { dismissPassageNotice, reportPassageChanged } from "@/core/editor/passage-notice-store";
import type { ContextPassageAnchor } from "@/features/chat/ChatContextNavigation";
import { LatestNavigationCoordinator } from "@/features/chat/latest-navigation-coordinator";
import { findContextFile } from "@/features/project/context/context-tree";

export type ContextRouteTarget = {
  scheme: ProjectContextTreeScheme;
  path: string;
  workId: string | null;
};

/** Tell passage navigation that a door was opened. The passage is optional. */
export type PassageDoorOpened = (
  target: ContextRouteTarget,
  passage?: ContextPassageAnchor,
) => void;

export function usePassageDoors(projectId: string, activeWorkId: string | null): PassageDoorOpened {
  const coordinator = useRef(new LatestNavigationCoordinator());

  // A resolution belongs to the scope it began in. Changing project or work
  // retires it exactly as a newer door would: the transcript it came from is
  // no longer the one in front of the writer.
  useEffect(() => {
    const scoped = coordinator.current;
    return () => scoped.dispose();
  }, [projectId, activeWorkId]);

  return useCallback(
    (target, passage) => {
      const resolving = coordinator.current.run(async (signal) => {
        // The previous door's answer stops being true the moment this one is
        // used, and that includes its notice. Clearing at the start also means
        // a landing never has to remember to clear it on the way out.
        dismissPassageNotice();
        if (!passage) return;

        const { tree } = await getProjectContextTree(
          projectId,
          target.scheme,
          target.workId ? { workId: target.workId } : undefined,
        );
        if (signal.aborted) return;
        const file = findContextFile(tree, target.path);
        // A binary or missing file has no Yjs document to land in; the door's
        // own destination already explains both.
        if (!file?.editable) return;

        const result = await navigateToPassage({
          documentId: file.documentId,
          anchor: passage,
          signal,
        });
        // Report only while this door is still the writer's latest: a stale
        // verdict about somewhere they have already left is worse than silence.
        if (signal.aborted) return;
        if (result.kind === "stale") reportPassageChanged(file.documentId);
      });
      // A lookup that fails leaves an open document, which is the door's real
      // promise; nothing here is worth interrupting the writer for.
      void resolving.catch(() => {});
    },
    [projectId],
  );
}
