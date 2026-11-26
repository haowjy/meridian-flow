import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getChatUploadFacts } from "@/client/api/projects-api";
import {
  authoritativeReferenceForFile,
  type DocumentReference,
  referenceSourceOf,
} from "@/core/completion";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { projectQueryKeys } from "./project-query-keys";
import { projectReadEnabled } from "./project-read-gate";
import { useProjectContextSources } from "./useContextSources";
import { useProjectTreeView } from "./useProjectTree";

export type ChatUpload = {
  documentId: string;
  name: string;
  fileType: string | null;
  uri: string;
  attachedAt: string | null;
  reference: DocumentReference | null;
  fileKind: "document" | "asset";
};

export function useChatUploads(projectId: string, chatId: string | null | undefined) {
  const accountId = useAccountId();
  const { tree, isComplete, isError } = useProjectTreeView(projectId, "uploads", {
    enabled: Boolean(chatId),
    chatThreadId: chatId,
  });
  const sources = useProjectContextSources(projectId);
  const files = useMemo(() => tree?.files() ?? [], [tree]);
  const facts = useQuery({
    queryKey: projectQueryKeys.chatUploads(projectId, chatId ?? "", files.length),
    queryFn: ({ signal }) => getChatUploadFacts(projectId, chatId ?? "", signal),
    enabled: projectReadEnabled(Boolean(chatId)),
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
