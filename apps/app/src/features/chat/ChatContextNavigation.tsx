import { createContext, type ReactNode, useContext } from "react";
import type { LinkTarget } from "@/core/editor/links";
import type { FollowPolicy } from "@/features/links";

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

export type PreparedDoor = { link: LinkTarget; policy: FollowPolicy };

export type ChatDoors = {
  canOpen: CanOpenContextUri;
  prepare(uri: string, passage?: ContextPassageAnchor): PreparedDoor | null;
  retire(): void;
};

const ChatDoorsContext = createContext<ChatDoors | null>(null);

export function ChatDoorsProvider({
  doors,
  children,
}: {
  doors: ChatDoors | null;
  children: ReactNode;
}) {
  return <ChatDoorsContext.Provider value={doors}>{children}</ChatDoorsContext.Provider>;
}

export function useChatDoors(): ChatDoors | null {
  return useContext(ChatDoorsContext);
}
