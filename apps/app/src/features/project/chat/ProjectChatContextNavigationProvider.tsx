/**
 * ProjectChatContextNavigationProvider — adapts chat-local document URI opens
 * to the project route's active-document contract.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { type ReactNode, useCallback } from "react";

import { ChatContextNavigationProvider } from "@/features/chat/ChatContextNavigation";
import { contextRouteTargetFromUri } from "@/lib/context-uri";

type SelectContextPath = (
  path: string,
  scheme?: ProjectContextTreeScheme,
  options?: { replace?: boolean },
) => void;

type OpenContextDocument = (path: string, scheme: ProjectContextTreeScheme) => void;

export function ProjectChatContextNavigationProvider({
  activeWorkId,
  onSelectContextPath,
  onOpenContextDocument,
  children,
}: {
  activeWorkId: string | null;
  onSelectContextPath?: SelectContextPath;
  onOpenContextDocument?: OpenContextDocument;
  children: ReactNode;
}) {
  const openContextUri = useCallback(
    (uri: string) => {
      const target = contextRouteTargetFromUri(uri, activeWorkId);
      if (!target) return;
      if (onOpenContextDocument) {
        onOpenContextDocument(target.path, target.scheme);
        return;
      }
      onSelectContextPath?.(target.path, target.scheme);
    },
    [activeWorkId, onOpenContextDocument, onSelectContextPath],
  );

  return (
    <ChatContextNavigationProvider
      onOpenContextUri={onOpenContextDocument || onSelectContextPath ? openContextUri : null}
    >
      {children}
    </ChatContextNavigationProvider>
  );
}
