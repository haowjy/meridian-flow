import { createContext, useContext } from "react";

/**
 * Where a chat is shown. Main's chat is the one the writer chose, so it takes focus when it
 * opens; the side's follows main and doesn't. The side's new chat keeps its own draft.
 */
export type ChatPlace = "main" | "side";

export const ChatPlaceContext = createContext<ChatPlace | null>(null);

/** Null outside a chat. */
export const useOptionalChatPlace = () => useContext(ChatPlaceContext);

export const useChatPlace = (): ChatPlace => useOptionalChatPlace() ?? "main";
