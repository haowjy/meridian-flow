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
/**
 * Opens a document by id, wherever it is now; `uri` is where the transcript
 * saw it, the fallback when the id leads nowhere.
 */
type OpenContextDocument = (documentId: string, uri: string) => void;

const ChatContextNavigationContext = createContext<OpenContextUri | null>(null);
const ChatContextRoutabilityContext = createContext<CanOpenContextUri | null>(null);
const ChatContextDocumentContext = createContext<OpenContextDocument | null>(null);

export function ChatContextNavigationProvider({
  onOpenContextUri,
  canOpenContextUri,
  onOpenContextDocument,
  children,
}: {
  onOpenContextUri?: OpenContextUri | null;
  canOpenContextUri?: CanOpenContextUri | null;
  onOpenContextDocument?: OpenContextDocument | null;
  children: ReactNode;
}) {
  return (
    <ChatContextNavigationContext.Provider value={onOpenContextUri ?? null}>
      <ChatContextRoutabilityContext.Provider value={canOpenContextUri ?? null}>
        <ChatContextDocumentContext.Provider value={onOpenContextDocument ?? null}>
          {children}
        </ChatContextDocumentContext.Provider>
      </ChatContextRoutabilityContext.Provider>
    </ChatContextNavigationContext.Provider>
  );
}

export function useChatContextNavigation(): OpenContextUri | null {
  return useContext(ChatContextNavigationContext);
}

export function useChatContextDocumentNavigation(): OpenContextDocument | null {
  return useContext(ChatContextDocumentContext);
}

export function useChatContextRoutability(): CanOpenContextUri | null {
  return useContext(ChatContextRoutabilityContext);
}
