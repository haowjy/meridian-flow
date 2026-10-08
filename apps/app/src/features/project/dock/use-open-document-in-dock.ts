/**
 * Opens a document where the writer is: in the dock on Work and Chat, and in
 * the Editor where the dock holds no document (the Editor screen, which opens
 * tabs, and the phone, whose documents open full-screen).
 */
import { useCallback } from "react";
import type { ServerContextTab } from "@/client/stores";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { useChatNavigation } from "../routing/chat-navigation";
import { useOpenContextRoute, useProjectScreen } from "../routing/ProjectNavigationContext";
import { useDockViewStore } from "./dock-view-store";

export function useOpenDocumentInDock() {
  const screen = useProjectScreen();
  const phone = usePhoneShell();
  const openDocument = useDockViewStore((state) => state.openDocument);
  const openContextRoute = useOpenContextRoute();
  const { revealDock } = useChatNavigation();
  return useCallback(
    (tab: ServerContextTab) => {
      if (screen === "context" || phone) {
        void openContextRoute?.(
          {
            scheme: tab.scheme,
            path: tab.path,
            workId: tab.workId,
            ...(tab.rootThreadId ? { rootThreadId: tab.rootThreadId } : {}),
          },
          { replace: false },
        );
        return;
      }
      openDocument({ screen, tab });
      revealDock("document");
    },
    [openContextRoute, openDocument, phone, revealDock, screen],
  );
}
