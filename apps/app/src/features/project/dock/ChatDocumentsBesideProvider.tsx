/**
 * Registers where chat doors open a document: in the dock's document slot when
 * the chat is in the middle (the Chat screen on a wide screen), so the URL stays
 * on the chat. On the Editor and Work screens the chat is the dock, so a dock
 * document would cover the chat the door was in, and the phone opens full
 * screen: both register nothing and doors keep opening Editor tabs or routes.
 */
import { type ReactNode, useCallback } from "react";
import type { ServerContextTab } from "@/client/stores";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { BesideChatContext } from "../context/open-chat-document";
import { useChatNavigation } from "../routing/chat-navigation";
import { useProjectScreen } from "../routing/ProjectNavigationContext";
import type { ScreenKey } from "../shell/screens";
import { useDockViewStore } from "./dock-view-store";

/** Whether a chat door's document opens in the dock, not in the Editor. */
export function opensBesideChat(screen: ScreenKey, phone: boolean): boolean {
  return screen === "chat" && !phone;
}

export function ChatDocumentsBesideProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const screen = useProjectScreen();
  const phone = usePhoneShell() === true;
  const { revealDock } = useChatNavigation();
  const open = useDockViewStore((state) => state.open);
  const beside = useCallback(
    (tab: ServerContextTab) => {
      open({ projectId, screen: "chat", tab });
      revealDock("document");
      return true;
    },
    [open, projectId, revealDock],
  );
  return (
    <BesideChatContext.Provider value={opensBesideChat(screen, phone) ? beside : null}>
      {children}
    </BesideChatContext.Provider>
  );
}
