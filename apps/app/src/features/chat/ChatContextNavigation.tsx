/**
 * ChatContextNavigation — optional chat-local bridge from written-document URIs
 * to whichever shell owns context-file routing.
 */
import type { ResourceCatalogCheckpoint } from "@meridian/resource-replica";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { LinkTarget } from "@/core/editor/links";
import type { FollowPolicy } from "@/features/links";
import { useAccountResourceProjection } from "@/features/project/context/account-feature-context";

/**
 * Where inside a document a door means to land. Both halves are required
 * because both are load-bearing: the hash finds the block, and the term is how
 * the destination verifies it is still the passage that matched. A door with
 * neither is an ordinary document door, which is most of them.
 */
export type ContextPassageAnchor = { blockHash: string; term: string };

export type OpenContextUri = (uri: string, passage?: ContextPassageAnchor) => void;
export type CanOpenContextUri = (uri: string) => boolean;

const ChatCatalogs = createContext<readonly ResourceCatalogCheckpoint[]>([]);

export function useChatFolderName(uri: string): string | undefined {
  const normalized = uri.replace(/\/$/, "");
  const catalogs = useContext(ChatCatalogs);
  return useMemo(() => {
    for (const checkpoint of catalogs) {
      const folder = checkpoint.entries.find(
        (entry) => entry.kind === "folder" && entry.uri.replace(/\/$/, "") === normalized,
      );
      if (folder?.kind === "folder") return folder.displayName ?? folder.name;
    }
    return undefined;
  }, [catalogs, normalized]);
}

const ChatContextNavigationContext = createContext<OpenContextUri | null>(null);
const ChatContextRoutabilityContext = createContext<CanOpenContextUri | null>(null);

export function ChatContextNavigationProvider({
  projectId,
  onOpenContextUri,
  canOpenContextUri,
  children,
}: {
  projectId: string;
  onOpenContextUri?: OpenContextUri | null;
  canOpenContextUri?: CanOpenContextUri | null;
  children: ReactNode;
}) {
  const { snapshot } = useAccountResourceProjection(projectId);
  return (
    <ChatCatalogs.Provider value={snapshot?.catalogs ?? []}>
      <ChatContextNavigationContext.Provider value={onOpenContextUri ?? null}>
        <ChatContextRoutabilityContext.Provider value={canOpenContextUri ?? null}>
          {children}
        </ChatContextRoutabilityContext.Provider>
      </ChatContextNavigationContext.Provider>
    </ChatCatalogs.Provider>
  );
}

export function useChatContextNavigation(): OpenContextUri | null {
  return useContext(ChatContextNavigationContext);
}

export function useChatContextRoutability(): CanOpenContextUri | null {
  return useContext(ChatContextRoutabilityContext);
}

/** A door's question for the chat's follower, with the door's own placement policy. */
export type PreparedDoor = { link: LinkTarget; policy: FollowPolicy };

/**
 * What the shell that owns document placement offers the chat's doors. The chat owns the
 * one follower (so one latest click, one visibility and thread lifetime, one dialog);
 * the shell only says what a door asks and where its answer goes.
 */
export type ChatDoors = {
  canOpen: CanOpenContextUri;
  /** Begins a door intent. Null when the address needs no question (the shell already routed it). */
  prepare(uri: string, passage?: ContextPassageAnchor): PreparedDoor | null;
  /** Another intent began (a transcript click): a passage still landing is no longer the writer's. */
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
