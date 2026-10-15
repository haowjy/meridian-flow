/**
 * The files attached to one chat, newest first: what the chat's uploads dropdown lists.
 *
 * Reads the chat's catalog scope, so a subagent's view passes its top chat's id. A chat
 * that is still being created has no uploads on the server, so nothing is asked until it exists.
 */
import type { CatalogFileEntry } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import { useContextCatalogScope } from "./useContextCatalog";

export type ChatUpload = {
  documentId: string;
  name: string;
  /** The stored file type, for the row's icon. */
  fileType: string | null;
  uri: string;
  /** When the file was attached; null until the server reports it. */
  attachedAt: string | null;
  /** A sent message used it, so it can no longer be deleted. */
  used: boolean;
};

export function useChatUploads(projectId: string, chatId: string | null | undefined) {
  const query = useContextCatalogScope(
    projectId,
    { kind: "chat", projectId, chatId: chatId ?? "" },
    Boolean(chatId),
  );
  const uploads = useMemo<ChatUpload[]>(() => {
    const files = [...(query.data?.entries.values() ?? [])].filter(
      (entry): entry is CatalogFileEntry => entry.kind === "file",
    );
    return files
      .map((entry) => ({
        documentId: entry.entryId,
        name: entry.name,
        fileType: entry.editable ? entry.filetype : (entry.fileType ?? null),
        uri: entry.uri,
        attachedAt: entry.upload?.attachedAt ?? null,
        used: entry.upload?.used ?? false,
      }))
      .sort((left, right) => (right.attachedAt ?? "").localeCompare(left.attachedAt ?? ""));
  }, [query.data]);
  return {
    uploads,
    isLoading: Boolean(chatId) && query.data === undefined && !query.isError,
    isError: query.isError,
  };
}
