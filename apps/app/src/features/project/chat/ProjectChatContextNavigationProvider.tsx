/**
 * ProjectChatContextNavigationProvider — adapts chat-local document URI opens
 * to the project route's context-file selection contract.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { type ReactNode, useCallback } from "react";

import { useContextWorkId } from "@/client/query/useContextWorkId";
import { ChatContextNavigationProvider } from "@/features/chat/ChatContextNavigation";

import { contextRouteTargetFromUri } from "./context-uri-route";

type SelectContextPath = (
  path: string,
  scheme?: ProjectContextTreeScheme,
  options?: { replace?: boolean },
) => void;

export function ProjectChatContextNavigationProvider({
  projectId,
  activeThreadId,
  onSelectContextPath,
  children,
}: {
  projectId: string;
  activeThreadId: string | null;
  onSelectContextPath?: SelectContextPath;
  children: ReactNode;
}) {
  const activeWorkId = useContextWorkId(projectId, activeThreadId);
  const openContextUri = useCallback(
    (uri: string) => {
      if (!onSelectContextPath) return;
      const target = contextRouteTargetFromUri(uri, activeWorkId);
      if (!target) return;
      onSelectContextPath(target.path, target.scheme);
    },
    [activeWorkId, onSelectContextPath],
  );

  return (
    <ChatContextNavigationProvider onOpenContextUri={onSelectContextPath ? openContextUri : null}>
      {children}
    </ChatContextNavigationProvider>
  );
}
