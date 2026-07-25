/**
 * ChatContextNavigation — optional chat-local bridge from written-document URIs
 * to whichever shell owns context-file routing.
 */
import { createContext, type ReactNode, useContext } from "react";

export type OpenContextUri = (uri: string) => void;
export type CanOpenContextUri = (uri: string) => boolean;

const ChatContextNavigationContext = createContext<OpenContextUri | null>(null);
const ChatContextRoutabilityContext = createContext<CanOpenContextUri | null>(null);

export function ChatContextNavigationProvider({
  onOpenContextUri,
  canOpenContextUri,
  children,
}: {
  onOpenContextUri?: OpenContextUri | null;
  canOpenContextUri?: CanOpenContextUri | null;
  children: ReactNode;
}) {
  return (
    <ChatContextNavigationContext.Provider value={onOpenContextUri ?? null}>
      <ChatContextRoutabilityContext.Provider value={canOpenContextUri ?? null}>
        {children}
      </ChatContextRoutabilityContext.Provider>
    </ChatContextNavigationContext.Provider>
  );
}

export function useChatContextNavigation(): OpenContextUri | null {
  return useContext(ChatContextNavigationContext);
}

export function useChatContextRoutability(): CanOpenContextUri | null {
  return useContext(ChatContextRoutabilityContext);
}
