import { workIdOfDraftOwnerKey } from "@meridian/contracts/branches";
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import { isWorkArchived, type Work } from "@meridian/contracts/works";
import { useOwnerDraftsFrozen } from "@/client/query/useOwnerDrafts";
import { useWorks } from "@/client/query/useWorks";
import type { OpenDocument } from "@/client/stores";

/**
 * Why an open document is read-only: its archived Work (the Work that owns the file, or the
 * Work whose draft is under review), or the trashed chat whose draft is under review.
 */
export type DocumentFreeze = { kind: "work"; work: Work } | { kind: "chat"; ownerKey: string };

/**
 * What freezes `tab` as shown. `reviewOwner` is the owner key of the draft under review in
 * it, or null when it shows the live document. A trashed chat's state is the server's, read
 * from its draft list (`ThreadDraftListResponse.frozen`).
 */
export function useDocumentFreeze(
  projectId: string,
  tab: OpenDocument | null,
  reviewOwner: string | null,
): DocumentFreeze | null {
  const { works } = useWorks(projectId);
  const chatFrozen = useOwnerDraftsFrozen(projectId, reviewOwner ?? "");
  const workId =
    tab && tab.kind !== "new" && tab.workId && isWorkScopedScheme(tab.scheme)
      ? tab.workId
      : reviewOwner && workIdOfDraftOwnerKey(reviewOwner);
  const work = workId ? works?.find((candidate) => candidate.id === workId) : undefined;
  if (work && isWorkArchived(work)) return { kind: "work", work };
  if (reviewOwner && chatFrozen) return { kind: "chat", ownerKey: reviewOwner };
  return null;
}
