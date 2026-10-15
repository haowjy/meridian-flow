/** Project-route composition for document doors: what happens to passage state every time the writer opens one. */
import { contextOwner, type ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useCallback, useEffect, useRef } from "react";

import { lookupContextCatalogFile } from "@/client/query/useContextCatalog";
import { navigateToPassage } from "@/core/editor/passage-navigation";
import { dismissPassageNotice, reportPassageChanged } from "@/core/editor/passage-notice-store";
import type { ContextPassageAnchor } from "@/features/chat/ChatContextNavigation";
import { LatestNavigationCoordinator } from "@/features/chat/latest-navigation-coordinator";
import { useOpenChatDocument } from "@/features/project/context/open-chat-document";

export type PassageDoorTarget = {
  scheme: ProjectContextTreeScheme;
  path: string;
  workId: string | null;
  /** A chat's Scratch is held by its lineage instead of a Work. */
  rootThreadId?: string;
  uri: string;
};

/**
 * What the door already resolved: the document the resolver named. Its identity is the
 * only one this door may open. The door has not opened it: the passage owns the open,
 * landing on the anchor when the file is editable and plainly otherwise.
 */
export type PassageDoorResolved = { documentId: string; claim?: number };

/** Tell passage navigation that a door began (retiring any earlier one) or was resolved. The passage is optional. */
export type PassageDoorOpened = (
  target: PassageDoorTarget,
  passage?: ContextPassageAnchor,
  resolved?: PassageDoorResolved,
) => void;

export function usePassageDoors(projectId: string, activeWorkId: string | null): PassageDoorOpened {
  const coordinator = useRef(new LatestNavigationCoordinator());
  const openDocument = useOpenChatDocument(projectId);

  // A resolution belongs to the scope it began in. Changing project or work
  // retires it exactly as a newer door would: the transcript it came from is
  // no longer the one in front of the writer.
  useEffect(() => {
    const scoped = coordinator.current;
    return () => scoped.dispose();
  }, [projectId, activeWorkId]);

  return useCallback(
    (target, passage, resolved) => {
      const resolving = coordinator.current.run(async (signal) => {
        // The previous door's answer stops being true the moment this one is
        // used, and that includes its notice. Clearing at the start also means
        // a landing never has to remember to clear it on the way out.
        dismissPassageNotice();
        if (!passage) return;

        // The lookup only learns whether the named document is editable. Its failure, or an
        // answer naming another occupant of the address, leaves the document to open plainly.
        const found = await lookupContextCatalogFile(
          projectId,
          target.scheme,
          contextOwner(target.workId, target.rootThreadId),
          { uri: target.uri },
        ).catch(() => null);
        const file = !resolved || found?.documentId === resolved.documentId ? found : null;
        if (signal.aborted) return;
        // A binary or missing file has no Yjs document to land in; the door's
        // own destination already explains both, unless the door left the open to us.
        if (!file?.editable) {
          if (resolved)
            await openDocument({
              documentId: resolved.documentId,
              workId: target.workId ?? undefined,
              signal,
              claim: resolved.claim,
            });
          return;
        }

        const result = await navigateToPassage({
          documentId: file.documentId,
          anchor: passage,
          signal,
          openDocument: (documentId) =>
            openDocument({
              documentId,
              workId: target.workId ?? undefined,
              signal,
              claim: resolved?.claim,
            }),
        });
        // Report only while this door is still the writer's latest: a stale
        // verdict about somewhere they have already left is worse than silence.
        if (signal.aborted) return;
        if (result.kind === "stale") reportPassageChanged(file.documentId);
      });
      // Passage landing is best effort: the document is the door's real promise, and
      // nothing here is worth interrupting the writer for.
      void resolving.catch(() => {});
    },
    [openDocument, projectId],
  );
}
