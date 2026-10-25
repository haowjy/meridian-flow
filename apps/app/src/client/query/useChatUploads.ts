/**
 * The files attached to one chat, newest first: what the chat's uploads dropdown lists.
 *
 * Reads the chat's catalog scope, so a subagent's view passes its top chat's id. A chat
 * that is still being created has no uploads on the server, so nothing is asked until it exists.
 */
import type { CatalogFileEntry } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import { authoritativeReferenceForFile, type DocumentReference } from "@/core/completion";
import { useContextCatalogScope } from "./useContextCatalog";

export type ChatUpload = {
  documentId: string;
  name: string;
  /** The stored file type, for the row's icon. */
  fileType: string | null;
  uri: string;
  /** When the file was attached; null until the server reports it. */
  attachedAt: string | null;
  /**
   * What deleting it must present. Null when it can't be deleted: a sent message used it, or the
   * server has not reported the upload's facts.
   */
  deletion: { intakeId: string; locationRevision: string } | null;
  /** The `@` reference the composer inserts for it; null when its address is not stable yet. */
  reference: DocumentReference | null;
  /** Whether the composer inserts it as an image (an asset) or a document reference. */
  fileKind: "document" | "asset";
};

const NO_AUTHORITIES = new Map();

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
        deletion:
          entry.upload && !entry.upload.used
            ? { intakeId: entry.upload.intakeId, locationRevision: entry.upload.locationRevision }
            : null,
        reference: authoritativeReferenceForFile(entry, NO_AUTHORITIES),
        fileKind: entry.editable ? ("document" as const) : ("asset" as const),
      }))
      .sort((left, right) => (right.attachedAt ?? "").localeCompare(left.attachedAt ?? ""));
  }, [query.data]);
  return {
    uploads,
    isLoading: Boolean(chatId) && query.data === undefined && !query.isError,
    isError: query.isError,
  };
}
