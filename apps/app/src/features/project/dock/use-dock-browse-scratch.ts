/**
 * The Scratch the dock's title menu offers at its root: the displayed chat's Scratch (the rail
 * section's own source), never the one the open document happens to belong to. Only the Chat
 * screen's dock holds a document.
 */

import { useChatScratchSource } from "../chat/use-chat-scratch-source";
import type { ScratchSource } from "../context/use-scratch-catalogs";
import { displayedChatThreadId, useChatNavigation } from "../routing/chat-navigation";
import { useProjectScreen } from "../routing/ProjectNavigationContext";

export function useDockBrowseScratch(projectId: string): ScratchSource | null {
  const screen = useProjectScreen();
  const { display } = useChatNavigation();
  const chatScratch = useChatScratchSource(
    projectId,
    screen === "chat" ? displayedChatThreadId(display) : null,
  );
  return chatScratch;
}
