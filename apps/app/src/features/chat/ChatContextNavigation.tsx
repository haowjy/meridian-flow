/**
 * ChatContextNavigation — optional chat-local bridge from written-document URIs
 * to whichever shell owns context-file routing.
 */
import { createContext, type ReactNode, useContext } from "react";

/**
 * Where inside a document a door means to land. Both halves are required
 * because both are load-bearing: the hash finds the block, and the term is how
 * the destination verifies it is still the passage that matched. A door with
 * neither is an ordinary document door, which is most of them.
 */
export type ContextPassageAnchor = { blockHash: string; term: string };

export type OpenContextUri = (uri: string, passage?: ContextPassageAnchor) => void;
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
