import { createContext, type ReactNode, useContext, useMemo } from "react";
import { type PanePlace, useOptionalPanePlace } from "@/features/project/pane-place";

export type OpenChatThread = (threadId: string) => void;

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
