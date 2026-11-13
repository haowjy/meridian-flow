/**
 * ChatThreadNavigation — chat-local bridge from a child thread id to the
 * project shell that owns chat routing.
 *
 * A spawn report's door, a background helper card's door, and the parent
 * breadcrumb call the same `onSelectThread`, so there is one chat router and
 * three entrances onto it.
 */
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { type PanePlace, useOptionalPanePlace } from "@/features/project/pane-place";

export type OpenChatThread = (threadId: string) => void;

/** The shell's router: it opens the chat where the pane the door is in places it. */
type RouteChatThread = (threadId: string, from: PanePlace | undefined) => void;

const ChatThreadNavigationContext = createContext<RouteChatThread | null>(null);

export function ChatThreadNavigationProvider({
  onOpenThread,
  children,
}: {
  onOpenThread?: RouteChatThread | null;
  children: ReactNode;
}) {
  return (
    <ChatThreadNavigationContext.Provider value={onOpenThread ?? null}>
      {children}
    </ChatThreadNavigationContext.Provider>
  );
}

export function useOpenChatThread(): OpenChatThread | null {
  const route = useContext(ChatThreadNavigationContext);
  const from = useOptionalPanePlace() ?? undefined;
  return useMemo(() => (route ? (threadId) => route(threadId, from) : null), [route, from]);
}
