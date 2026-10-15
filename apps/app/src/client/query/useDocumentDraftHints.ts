/**
 * useDocumentDraftHints — the active drafts with changes to one open document, from any
 * view. One read per document open: it re-reads on the same signals as the Work draft lists
 * (the writer's own draft commands, catalog wakes and identity changes invalidate its key),
 * and on window focus and reconnect through the query client's defaults. No polling.
 */
import type { DocumentDraftHint } from "@meridian/contracts/drafts";
import { useQuery } from "@tanstack/react-query";

import { listDocumentDraftHints } from "@/client/api/drafts-api";
import { projectQueryKeys } from "./project-query-keys";

const NONE: readonly DocumentDraftHint[] = [];

export function useDocumentDraftHints(
  projectId: string,
  documentId: string,
  options: { enabled: boolean },
): readonly DocumentDraftHint[] {
  const { data } = useQuery({
    queryKey: projectQueryKeys.documentDraftHints(projectId, documentId),
    queryFn: () => listDocumentDraftHints(projectId, documentId).then((answer) => answer.items),
    enabled: options.enabled && Boolean(projectId) && Boolean(documentId),
    staleTime: 15_000,
  });
  return data ?? NONE;
}
