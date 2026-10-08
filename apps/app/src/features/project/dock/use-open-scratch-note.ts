/**
 * Opens a note picked from a chat's Scratch menu next to that chat.
 *
 * The chat is in the middle on the Chat screen, so the note opens in the
 * dock's document, covering the context rail until closed. Everywhere else the
 * chat is docked beside the middle pane or is a phone sheet, so the note opens
 * where the middle pane is: an Editor tab, or the phone's full-screen
 * document. Work Files notes do not use this: they open in the dock on the
 * Work screen (`useOpenDocumentInDock`).
 */
import { useCallback } from "react";
import type { ServerContextTab } from "@/client/stores";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { useChatNavigation } from "../routing/chat-navigation";
import { useProjectScreen } from "../routing/ProjectNavigationContext";
import { useOpenDocumentInEditor } from "../routing/use-open-document-in-editor";
import { useDockViewStore } from "./dock-view-store";

export function useOpenScratchNote() {
  const screen = useProjectScreen();
  const phone = usePhoneShell();
  const openDocument = useDockViewStore((state) => state.openDocument);
  const openInEditor = useOpenDocumentInEditor();
  const { revealDock } = useChatNavigation();
  return useCallback(
    (tab: ServerContextTab) => {
      if (screen === "chat" && !phone) {
        openDocument({ screen, tab });
        revealDock("document");
        return;
      }
      openInEditor(tab);
    },
    [openDocument, openInEditor, phone, revealDock, screen],
  );
}
