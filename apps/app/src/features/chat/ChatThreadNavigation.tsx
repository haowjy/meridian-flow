/**
 * ChatThreadNavigation — chat-local bridge from a child thread id to the
 * project shell that owns chat routing.
 *
 * A spawn report's door, a background helper card's door, and the parent
 * breadcrumb call the same `onSelectThread`, so there is one chat router and
 * three entrances onto it.
 */
import { createContext, type ReactNode, useContext } from "react";

export type OpenChatThread = (threadId: string) => void;

const ChatThreadNavigationContext = createContext<OpenChatThread | null>(null);

export function ChatThreadNavigationProvider({
  onOpenThread,
  children,
}: {
  onOpenThread?: OpenChatThread | null;
  children: ReactNode;
}) {
  return (
    <ChatThreadNavigationContext.Provider value={onOpenThread ?? null}>
      {children}
    </ChatThreadNavigationContext.Provider>
  );
}

export function useOpenChatThread(): OpenChatThread | null {
  return useContext(ChatThreadNavigationContext);
}
