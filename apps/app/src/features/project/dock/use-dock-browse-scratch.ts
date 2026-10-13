/**
 * The Scratch the dock's title menu offers at its root: the one the writer has on
 * screen, never the one the open document happens to belong to.
 * - Chat screen: the displayed chat's Scratch (the rail section's own source).
 * - Work screen: the route's Work, which is whose Files are showing.
 * Elsewhere the dock holds no document.
 */
import { t } from "@lingui/core/macro";
import { useMemo } from "react";
import { useWorks } from "@/client/query/useWorks";
import { useChatScratchSource } from "../chat/use-chat-scratch-source";
import { schemeLabel } from "../context/context-schemes";
import type { ScratchSource } from "../context/use-catalog-menu-source";
import { displayedChatThreadId, useChatNavigation } from "../routing/chat-navigation";
import { useProjectScreen } from "../routing/ProjectNavigationContext";
import { useDockDocumentStore } from "./dock-document-store";

export function useDockBrowseScratch(projectId: string): ScratchSource | null {
  const screen = useProjectScreen();
  const { display } = useChatNavigation();
  const chatScratch = useChatScratchSource(
    projectId,
    screen === "chat" ? displayedChatThreadId(display) : null,
  );
  const routeWorkId = useDockDocumentStore((state) => (screen === "work" ? state.workId : null));
  const { works } = useWorks(projectId);
  const workName = routeWorkId ? works?.find((work) => work.id === routeWorkId)?.name : undefined;
  const workScratch = useMemo<ScratchSource | null>(
    () =>
      routeWorkId
        ? {
            owner: { workId: routeWorkId },
            heading: workName ? t`Scratch for ${workName}` : schemeLabel("scratch"),
          }
        : null,
    [routeWorkId, workName],
  );
  return screen === "work" ? workScratch : chatScratch;
}
