/**
 * ProjectChatContextNavigationProvider — adapts chat-local document URI opens
 * to the project route's context-file selection contract.
 *
 * Every door routes the same way, and every door tells passage navigation it
 * happened — carrying an anchor when the row had one. That second call is not
 * an extra for passage rows: it is where navigation ownership changes hands,
 * so an ordinary door retires whatever a search row was still resolving. It
 * never gates the route change, so a search row whose passage has moved still
 * opens its document.
 */
import { type ReactNode, useCallback } from "react";
import { useWorks } from "@/client/query/useWorks";
import {
  ChatContextNavigationProvider,
  type ContextPassageAnchor,
} from "@/features/chat/ChatContextNavigation";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";
import {
  contextRouteTargetFromUri,
  canOpenContextUri as isContextUriRoutable,
} from "@/lib/context-uri";
import type { ContextRouteRequest } from "../routing/project-route";
import { usePassageDoors } from "./usePassageDoors";

type OpenContextTarget = (target: ContextRouteRequest) => void;

export function ProjectChatContextNavigationProvider({
  projectId,
  activeWork,
  availableWorks,
  onOpenContextTarget,
  children,
}: {
  projectId: string;
  activeWork: { id: string; slug: string | null } | null;
  availableWorks: readonly { id: string; slug: string | null }[];
  onOpenContextTarget?: OpenContextTarget;
  children: ReactNode;
}) {
  const { noWork } = useWorks(projectId);
  const noWorkId = noWork?.id;
  const doorOpened = usePassageDoors(projectId, activeWork?.id ?? null);
  const openContextUri = useCallback(
    (uri: string, passage?: ContextPassageAnchor) => {
      if (!onOpenContextTarget || !activeWork || !noWorkId) return;
      const target = contextRouteTargetFromUri(uri, activeWork, availableWorks, noWorkId);
      if (!target) return;
      onOpenContextTarget({ ...target, workId: target.workId ?? undefined });
      doorOpened({ ...target, uri }, passage);
    },
    [activeWork, availableWorks, noWorkId, doorOpened, onOpenContextTarget],
  );
  const openDocument = useOpenProjectDocument(projectId);
  // The id finds the document after a move. One that is gone leads nowhere,
  // so the door falls back to where the transcript saw it, which says so.
  const openContextDocument = useCallback(
    (documentId: string, uri: string) => {
      if (!onOpenContextTarget || !activeWork || !noWorkId) return;
      const target = contextRouteTargetFromUri(uri, activeWork, availableWorks, noWorkId);
      if (target) doorOpened({ ...target, uri });
      void openDocument({ documentId, workId: target?.workId ?? undefined }).then((result) => {
        if (result.kind === "unavailable") openContextUri(uri);
      });
    },
    [
      activeWork,
      availableWorks,
      noWorkId,
      doorOpened,
      onOpenContextTarget,
      openDocument,
      openContextUri,
    ],
  );
  const canOpenContextUri = useCallback(
    (uri: string) =>
      !!activeWork && !!noWorkId && isContextUriRoutable(uri, activeWork, availableWorks, noWorkId),
    [activeWork, availableWorks, noWorkId],
  );

  return (
    <ChatContextNavigationProvider
      onOpenContextUri={onOpenContextTarget ? openContextUri : null}
      canOpenContextUri={onOpenContextTarget ? canOpenContextUri : null}
      onOpenContextDocument={onOpenContextTarget ? openContextDocument : null}
    >
      {children}
    </ChatContextNavigationProvider>
  );
}
