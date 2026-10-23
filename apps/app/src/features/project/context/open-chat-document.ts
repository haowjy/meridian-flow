/**
 * Opens a document from a chat door (a link chip, a receipt row, a passage or
 * tool-result door, an `@` reference, a Recent row).
 *
 * Every id-keyed door opens through the navigation adapter; this is the one
 * wrapper they share. It claims the dock at the start of the intent and offers
 * the resolved tab to whatever the project shell registered as "beside the chat"
 * (`ChatDocumentsBesideProvider`): on the Chat screen that is the dock, so the
 * address stays on the chat, and a newer intent makes the older one `cancelled`.
 * With nothing registered the open is the ordinary one. A new-tab gesture keeps
 * its background tab.
 */
import { createContext, useCallback, useContext } from "react";
import type { ContextTab } from "@/client/stores";
import { useDockDocumentStore } from "../dock/dock-document-store";
import type { ReviewAddress } from "../presented-document";
import {
  type OpenProjectDocument,
  type OpenProjectDocumentRequest,
  useOpenProjectDocument,
} from "./open-project-document";

/** Shows the tab beside the chat under a claim; `cancelled` if a newer intent won. */
export type OpenBesideChat = (
  tab: ContextTab,
  claim: number,
  focus?: true,
  /** A draft-only review's address: the dock shows it by item identity, not by path. */
  review?: ReviewAddress,
) => { kind: "opened"; tab: ContextTab } | { kind: "cancelled" };

export const BesideChatContext = createContext<OpenBesideChat | null>(null);

export type ChatDocumentRequest = OpenProjectDocumentRequest & {
  /** A claim the caller took when its intent began (a URI door claims before its lookup). */
  claim?: number;
};

/**
 * Opens a chat's own resource (an upload) where this host has a viewer for it, null where it
 * has none. An upload has no Editor route, so the one viewer is the dock beside a centered chat.
 * A host without it (the docked chat on Work and Editor pages, the phone) must not offer Open.
 */
export function useOpenChatResource(
  projectId: string | undefined,
): ReturnType<typeof useOpenChatDocument> | null {
  const open = useOpenChatDocument(projectId);
  return useContext(BesideChatContext) ? open : null;
}

/** Whether a reference to `uri` can be opened here: an upload only where its viewer is. */
export function useCanOpenChatReference(): (uri: string) => boolean {
  const hasResourceViewer = useContext(BesideChatContext) !== null;
  return useCallback(
    (uri) => hasResourceViewer || !uri.startsWith("uploads://"),
    [hasResourceViewer],
  );
}

export function useOpenChatDocument(
  projectId: string | undefined,
): (request: ChatDocumentRequest) => ReturnType<OpenProjectDocument> {
  const open = useOpenProjectDocument(projectId);
  const beside = useContext(BesideChatContext);
  return useCallback(
    ({ claim, ...request }) => {
      if (request.disposition === "background" || !beside) return open(request);
      const attempt = claim ?? useDockDocumentStore.getState().claim();
      return open({ ...request, beside: (tab, focus) => beside(tab, attempt, focus) });
    },
    [beside, open],
  );
}
