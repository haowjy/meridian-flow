/**
 * useReviewRefresh — the one owner of "the open review's draft changed, read it
 * again". It watches the review room (the draft's text: the writer typing, the
 * AI writing, a peer editing) and the live document the draft is measured
 * against (another tab's Apply, a collaborator), and after the changes settle
 * invalidates the Work's draft list and the draft's preview once.
 *
 * The manuscript does not subscribe on its own: `useInlineReviewSync` only
 * projects the preview this refreshes into the editor, so a local edit costs one
 * read, and the review stays current with no editor mounted (the dock alone).
 *
 * A burst of changes is one read after it settles (`SETTLE_MS`), but a stream
 * that never pauses (the AI writing) still refreshes every `MAX_WAIT_MS`, so the
 * review does not sit on a stale list until the stream ends.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { projectQueryKeys } from "@/client/query/project-query-keys";
import type { DocumentSession } from "@/core/editor/document-session";

const SETTLE_MS = 500;
const MAX_WAIT_MS = 2_000;

export function useReviewRefresh({
  projectId,
  workId,
  review,
  session,
  liveSession,
}: {
  projectId: string | null;
  workId: string | null;
  /** The open review's draft, or null when none is open. */
  review: { documentId: string; draftId: string } | null;
  /** The review's room, once resolved. */
  session: DocumentSession | null;
  /** The live document of the reviewed draft, when a surface holds it. */
  liveSession: DocumentSession | null;
}): void {
  const queryClient = useQueryClient();
  const documentId = review?.documentId ?? null;
  const draftId = review?.draftId ?? null;

  useEffect(() => {
    if (!projectId || !workId || !documentId || !draftId) return;
    const sources: DocumentSession[] = [];
    if (session) sources.push(session);
    if (liveSession) sources.push(liveSession);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let firstPendingAt = 0;
    let active = true;
    let refreshing = false;
    let trailing = false;
    const refresh = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (refreshing) {
        trailing = true;
        return;
      }
      refreshing = true;
      void Promise.all([
        queryClient.invalidateQueries(
          {
            queryKey: projectQueryKeys.workDrafts(projectId, workId),
          },
          { cancelRefetch: false },
        ),
        queryClient.invalidateQueries(
          {
            queryKey: projectQueryKeys.workDraftPreview(projectId, workId, documentId, draftId),
          },
          { cancelRefetch: false },
        ),
      ]).finally(() => {
        refreshing = false;
        if (active && trailing) {
          trailing = false;
          refresh();
        }
      });
    };
    const schedule = () => {
      const now = Date.now();
      if (timer === null) firstPendingAt = now;
      else clearTimeout(timer);
      timer = setTimeout(
        refresh,
        Math.min(SETTLE_MS, Math.max(0, firstPendingAt + MAX_WAIT_MS - now)),
      );
    };
    for (const source of sources) source.document.on("update", schedule);
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
      for (const source of sources) source.document.off("update", schedule);
    };
  }, [projectId, workId, documentId, draftId, session, liveSession, queryClient]);
}
