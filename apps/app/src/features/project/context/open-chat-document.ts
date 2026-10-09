/**
 * Opens a document from a chat door (a link chip, a receipt row, a passage or
 * tool-result door, an `@` reference).
 *
 * Every chat door opens a document through `useOpenProjectDocument`; this is the
 * one wrapper they share. It offers the resolved tab to whatever the project
 * shell has registered as "beside the chat" (`ChatDocumentsBesideProvider`):
 * on the Chat screen that is the dock's document slot, so the URL stays on the
 * chat. With nothing registered (the chat rendered outside a project shell, or a
 * screen where the dock is the chat) the open is the ordinary one. A new-tab
 * gesture keeps its background tab.
 */
import { createContext, useCallback, useContext } from "react";
import type { ServerContextTab } from "@/client/stores";
import { useDockViewStore } from "../dock/dock-view-store";
import {
  type OpenProjectDocument,
  type OpenProjectDocumentRequest,
  useOpenProjectDocument,
} from "./open-project-document";

export type OpenBesideChat = (tab: ServerContextTab) => boolean;

export const BesideChatContext = createContext<OpenBesideChat | null>(null);

/**
 * A claim on the dock as it is now: still true until anything else changes what
 * the dock shows (a pick, a Close, a view, a scope change). A slow door that
 * finds its claim gone stands down instead of reversing the writer's newer choice.
 */
export type DockClaim = () => boolean;

export function claimDock(): DockClaim {
  const { revision } = useDockViewStore.getState();
  return () => useDockViewStore.getState().revision === revision;
}

export type ChatDocumentRequest = OpenProjectDocumentRequest & {
  /** Claimed when the door began, so a lookup before this open is inside the claim. */
  claim?: DockClaim;
};

export function useOpenChatDocument(
  projectId: string | undefined,
): (request: ChatDocumentRequest) => ReturnType<OpenProjectDocument> {
  const open = useOpenProjectDocument(projectId);
  const beside = useContext(BesideChatContext);
  return useCallback(
    ({ claim, ...request }) => {
      if (request.disposition === "background" || !beside) return open(request);
      const stillLatest = claim ?? claimDock();
      return open({ ...request, beside: (tab) => (stillLatest() ? beside(tab) : true) });
    },
    [beside, open],
  );
}
