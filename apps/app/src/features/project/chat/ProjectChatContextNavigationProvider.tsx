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

import {
  ChatContextNavigationProvider,
  type ContextPassageAnchor,
} from "@/features/chat/ChatContextNavigation";
import {
  contextRouteTargetFromUri,
  canOpenContextUri as isContextUriRoutable,
} from "@/lib/context-uri";
import type { ContextRouteTarget } from "../routing/project-route";
import { usePassageDoors } from "./usePassageDoors";

type OpenContextTarget = (target: ContextRouteTarget) => void;

export function ProjectChatContextNavigationProvider({
  projectId,
  activeWork,
  onOpenContextTarget,
  children,
}: {
  projectId: string;
  activeWork: { id: string; slug: string } | null;
  onOpenContextTarget?: OpenContextTarget;
  children: ReactNode;
}) {
  const doorOpened = usePassageDoors(projectId, activeWork?.id ?? null);
  const openContextUri = useCallback(
    (uri: string, passage?: ContextPassageAnchor) => {
      if (!onOpenContextTarget) return;
      const target = contextRouteTargetFromUri(uri, activeWork);
      if (!target || !activeWork) return;
      onOpenContextTarget({ ...target, workId: activeWork.id });
      doorOpened(target, passage);
    },
    [activeWork, doorOpened, onOpenContextTarget],
  );
  const canOpenContextUri = useCallback(
    (uri: string) => isContextUriRoutable(uri, activeWork),
    [activeWork],
  );

  return (
    <ChatContextNavigationProvider
      onOpenContextUri={onOpenContextTarget ? openContextUri : null}
      canOpenContextUri={onOpenContextTarget ? canOpenContextUri : null}
    >
      {children}
    </ChatContextNavigationProvider>
  );
}
