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
import type { ServerContextTab } from "@/client/stores";
import { useDockDocumentStore } from "../dock/dock-document-store";
import {
  type OpenProjectDocument,
  type OpenProjectDocumentRequest,
  useOpenProjectDocument,
} from "./open-project-document";

/** Shows the tab beside the chat under a claim; `cancelled` if a newer intent won. */
export type OpenBesideChat = (tab: ServerContextTab, claim: number) => "opened" | "cancelled";

export const BesideChatContext = createContext<OpenBesideChat | null>(null);

export type ChatDocumentRequest = OpenProjectDocumentRequest & {
  /** A claim the caller took when its intent began (a URI door claims before its lookup). */
  claim?: number;
};

export function useOpenChatDocument(
  projectId: string | undefined,
): (request: ChatDocumentRequest) => ReturnType<OpenProjectDocument> {
  const open = useOpenProjectDocument(projectId);
  const beside = useContext(BesideChatContext);
  return useCallback(
    ({ claim, ...request }) => {
      if (request.disposition === "background" || !beside) return open(request);
      const attempt = claim ?? useDockDocumentStore.getState().claim();
      return open({ ...request, beside: (tab) => beside(tab, attempt) });
    },
    [beside, open],
  );
}
