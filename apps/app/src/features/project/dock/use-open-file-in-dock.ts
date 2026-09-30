/** Opens a Work file in the dock and brings the dock into view. */
import { useCallback } from "react";
import type { ContextTab } from "@/client/stores";
import { useChatNavigation } from "../routing/chat-navigation";
import { useDockViewStore } from "./dock-view-store";

/** Open one read-only Scratch/Uploads file in the Work dock slot. */
export function useOpenFileInDock(workId: string) {
  const openWorkFile = useDockViewStore((state) => state.openWorkFile);
  const { revealDock } = useChatNavigation();
  return useCallback(
    (tab: Extract<ContextTab, { kind: "viewer" }>) => {
      openWorkFile({ workId, tab });
      revealDock("file");
    },
    [openWorkFile, revealDock, workId],
  );
}
