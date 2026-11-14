/**
 * The files attached to one chat, newest first: what the chat's uploads dropdown lists.
 *
 * Names and addresses come from the chat's uploads tree, so a subagent's view passes its top
 * chat's id. When each file was attached and whether a sent message has used it come from the
 * chat's uploads query, which a chat that is still being created answers with nothing.
 */
import { skipToken, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getChatUploadFacts } from "@/client/api/projects-api";
import {
  authoritativeReferenceForFile,
  type DocumentReference,
  referenceSourceOf,
} from "@/core/completion";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { projectQueryKeys } from "./project-query-keys";
import { useProjectContextSources } from "./useContextSources";
import { useProjectTreeView } from "./useProjectTree";

export type ChatUpload = {
  documentId: string;
  name: string;
  /** The stored file type, for the row's icon. */
  fileType: string | null;
  uri: string;
  /** When the file was attached; null until the server reports it. */
  attachedAt: string | null;
  /** Whether the writer may delete it: no sent message used it, and the server has reported its facts. */
  deletable: boolean;
  /** The `@` reference the composer inserts for it; null when its address is not stable yet. */
  reference: DocumentReference | null;
  /** Whether the composer inserts it as an image (an asset) or a document reference. */
  fileKind: "document" | "asset";
};

export function useChatUploads(projectId: string, chatId: string | null | undefined) {
  const accountId = useAccountId();
  const { tree, isComplete, isError } = useProjectTreeView(projectId, "uploads", {
    enabled: Boolean(chatId),
    chatId,
  });
  const sources = useProjectContextSources(projectId);
  const files = useMemo(() => tree?.files() ?? [], [tree]);
  const facts = useQuery({
    queryKey: projectQueryKeys.chatUploads(projectId, chatId ?? "", files.length),
    queryFn: chatId ? ({ signal }) => getChatUploadFacts(projectId, chatId, signal) : skipToken,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
  const uploads = useMemo<ChatUpload[]>(() => {
    const source = tree && sources?.find((candidate) => candidate.id === tree.root.entryId);
    const referenceSource = source ? referenceSourceOf(source, { projectId, accountId }) : null;
    const known = new Map(facts.data?.uploads.map((upload) => [upload.documentId, upload]));
    return files
      .map((file) => {
        const upload = known.get(file.documentId);
        return {
          documentId: file.documentId,
          name: file.name,
          fileType: file.editable ? file.filetype : (file.fileType ?? null),
          uri: file.uri,
          attachedAt: upload?.attachedAt ?? null,
          deletable: upload !== undefined && !upload.used,
          reference: referenceSource ? authoritativeReferenceForFile(file, referenceSource) : null,
          fileKind: file.editable ? ("document" as const) : ("asset" as const),
        };
      })
      .sort((left, right) => (right.attachedAt ?? "").localeCompare(left.attachedAt ?? ""));
  }, [accountId, facts.data, files, projectId, sources, tree]);
  return {
    uploads,
    isLoading: Boolean(chatId) && !isComplete && !isError,
    isError,
  };
}
