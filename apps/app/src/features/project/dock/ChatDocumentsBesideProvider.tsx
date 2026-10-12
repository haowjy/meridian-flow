/**
 * Registers where chat doors open a document: beside the chat, in the dock's
 * document slot, when the chat is in the middle (see `use-dock-placement`). The
 * address stays on the chat. Elsewhere nothing is registered and doors keep
 * opening Editor tabs and routes.
 */
import { type ReactNode, useMemo } from "react";
import { BesideChatContext } from "../context/open-chat-document";
import { useDockPlacement } from "./use-dock-placement";

export function ChatDocumentsBesideProvider({ children }: { children: ReactNode }) {
  const { besideChat, commit } = useDockPlacement();
  const beside = useMemo(() => (besideChat ? commit : null), [besideChat, commit]);
  return <BesideChatContext.Provider value={beside}>{children}</BesideChatContext.Provider>;
}
