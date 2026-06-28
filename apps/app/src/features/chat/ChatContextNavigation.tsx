/**
 * ChatContextNavigation — optional chat-local bridge from written-document URIs
 * to whichever shell owns context-file routing.
 */
import { createContext, type ReactNode, useContext } from "react";

export type OpenContextUri = (uri: string) => void;

const ChatContextNavigationContext = createContext<OpenContextUri | null>(null);

export function ChatContextNavigationProvider({
  onOpenContextUri,
  children,
}: {
  onOpenContextUri?: OpenContextUri | null;
  children: ReactNode;
}) {
  return (
    <ChatContextNavigationContext.Provider value={onOpenContextUri ?? null}>
      {children}
    </ChatContextNavigationContext.Provider>
  );
}

export function useChatContextNavigation(): OpenContextUri | null {
  return useContext(ChatContextNavigationContext);
}
