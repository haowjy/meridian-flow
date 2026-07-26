/**
 * ProjectChatContextNavigationProvider — adapts chat-local document URI opens
 * to the project route's context-file selection contract.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { type ReactNode, useCallback } from "react";

import { ChatContextNavigationProvider } from "@/features/chat/ChatContextNavigation";
import {
  contextRouteTargetFromUri,
  canOpenContextUri as isContextUriRoutable,
} from "@/lib/context-uri";

type SelectContextPath = (
  path: string,
  scheme?: ProjectContextTreeScheme,
  options?: { replace?: boolean },
) => void;

export function ProjectChatContextNavigationProvider({
  activeWorkId,
  onSelectContextPath,
  children,
}: {
  activeWorkId: string | null;
  onSelectContextPath?: SelectContextPath;
  children: ReactNode;
}) {
  const openContextUri = useCallback(
    (uri: string) => {
      if (!onSelectContextPath) return;
      const target = contextRouteTargetFromUri(uri, activeWorkId);
      if (!target) return;
      onSelectContextPath(target.path, target.scheme);
    },
    [activeWorkId, onSelectContextPath],
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
