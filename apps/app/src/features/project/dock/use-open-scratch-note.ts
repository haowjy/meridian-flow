/**
 * Opens a note picked from the rail's Scratch section next to that chat: beside
 * it in the dock when the chat is in the middle, and otherwise where the middle
 * pane is (an Editor tab, or the phone's full-screen document). Work Files notes
 * use `useOpenDocumentInDock`. See `use-dock-placement` for the rules.
 */
import { useCallback } from "react";
import type { ServerContextTab } from "@/client/stores";
import { useOpenDocumentInEditor } from "../routing/use-open-document-in-editor";
import { useDockPlacement } from "./use-dock-placement";

export function useOpenScratchNote() {
  const placement = useDockPlacement();
  const openInEditor = useOpenDocumentInEditor();
  return useCallback(
    (tab: ServerContextTab) => {
      if (placement.besideChat) placement.commit(tab);
      else openInEditor(tab);
    },
    [openInEditor, placement],
  );
}
