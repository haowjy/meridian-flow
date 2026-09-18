/**
 * ChatThreadNavigation — optional chat-local bridge from a child thread id to
 * whichever shell owns chat routing.
 *
 * A spawn report's door and the background helper card's door call the same
 * `onSelectThread` the parent breadcrumb uses, so there is one chat router and
 * two entrances onto it. Outside a project shell the hook returns `null` and
 * every door degrades to inert text, exactly like `DocumentName`.
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
