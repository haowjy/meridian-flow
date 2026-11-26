import type { DocumentDraftHint } from "@meridian/contracts/drafts";
import { useQuery } from "@tanstack/react-query";

import { listDocumentDraftHints } from "@/client/api/drafts-api";
import { projectQueryKeys } from "./project-query-keys";
import { projectReadEnabled } from "./project-read-gate";

const NONE: readonly DocumentDraftHint[] = [];

export function useDocumentDraftHints(
  projectId: string,
  documentId: string,
  options: { enabled: boolean },
): readonly DocumentDraftHint[] {
  const { data } = useQuery({
    queryKey: projectQueryKeys.documentDraftHints(projectId, documentId),
    queryFn: () => listDocumentDraftHints(projectId, documentId).then((answer) => answer.items),
    enabled: projectReadEnabled(options.enabled && Boolean(projectId) && Boolean(documentId)),
    staleTime: 15_000,
  });
  return data ?? NONE;
}
