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
import { type OpenProjectDocument, useOpenProjectDocument } from "./open-project-document";

export type OpenBesideChat = (tab: ServerContextTab) => boolean;

export const BesideChatContext = createContext<OpenBesideChat | null>(null);

export function useOpenChatDocument(projectId: string | undefined): OpenProjectDocument {
  const open = useOpenProjectDocument(projectId);
  const beside = useContext(BesideChatContext);
  return useCallback(
    (request) =>
      open(request.disposition === "background" || !beside ? request : { ...request, beside }),
    [beside, open],
  );
}
