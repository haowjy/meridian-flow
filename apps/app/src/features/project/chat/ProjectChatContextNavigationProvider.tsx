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
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { type ReactNode, useCallback } from "react";

import {
  ChatContextNavigationProvider,
  type ContextPassageAnchor,
} from "@/features/chat/ChatContextNavigation";
import {
  contextRouteTargetFromUri,
  canOpenContextUri as isContextUriRoutable,
} from "@/lib/context-uri";
import { usePassageDoors } from "./usePassageDoors";

type SelectContextPath = (
  path: string,
  scheme?: ProjectContextTreeScheme,
  options?: { replace?: boolean },
) => void;

export function ProjectChatContextNavigationProvider({
  projectId,
  activeWorkId,
  onSelectContextPath,
  children,
}: {
  projectId: string;
  activeWorkId: string | null;
  onSelectContextPath?: SelectContextPath;
  children: ReactNode;
}) {
  const doorOpened = usePassageDoors(projectId, activeWorkId);
  const openContextUri = useCallback(
    (uri: string, passage?: ContextPassageAnchor) => {
      if (!onSelectContextPath) return;
      const target = contextRouteTargetFromUri(uri, activeWorkId);
      if (!target) return;
      onSelectContextPath(target.path, target.scheme);
      doorOpened(target, passage);
    },
    [activeWorkId, doorOpened, onSelectContextPath],
  );
  const canOpenContextUri = useCallback(
    (uri: string) => isContextUriRoutable(uri, activeWorkId),
    [activeWorkId],
  );

  return (
    <ChatContextNavigationProvider
      onOpenContextUri={onSelectContextPath ? openContextUri : null}
      canOpenContextUri={onSelectContextPath ? canOpenContextUri : null}
    >
      {children}
    </ChatContextNavigationProvider>
  );
}
