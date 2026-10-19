/**
 * Refresh discovery when review membership or the independent live document changes, never on each draft key.
 * The timer belongs to the review identity, not either room binding: a pending refresh survives rebind.
 * A stream of discovery changes refreshes at least every MAX_WAIT_MS instead of waiting forever for quiet.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { projectQueryKeys } from "@/client/query/project-query-keys";
import type { DocumentSession } from "@/core/editor/document-session";
import type { ReviewRuntime, ReviewState } from "./review-runtime";

const SETTLE_MS = 500;
const MAX_WAIT_MS = 2_000;

export function useReviewRefresh({
  projectId,
  workId,
  review,
  runtime,
  session,
  liveSession,
}: {
  projectId: string | null;
  workId: string | null;
  /** The open review's draft, or null when none is open. */
  review: { documentId: string; itemKey: string } | null;
  /** Text and attribution already computed for this review. */
  runtime: ReviewRuntime | null;
  /** Discovery reads the committed membership after this room acknowledges the semantic change. */
  session: DocumentSession | null;
  /** The live document of the reviewed draft, when a surface holds it. */
  liveSession: DocumentSession | null;
}): void {
  const queryClient = useQueryClient();
  const documentId = review?.documentId ?? null;
  const itemKey = review?.itemKey ?? null;

  const schedule = useRef<(() => void) | null>(null);

  // The pending read belongs to the review, not to the rooms it listens to: an
  // editor re-binding its live room (its surface briefly inactive) must not
  // drop a change already seen, such as the pull that just reached the draft.
  useEffect(() => {
    if (!projectId || !workId || !documentId || !itemKey) return;
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
            queryKey: projectQueryKeys.workBranchDrafts(projectId, workId),
          },
          { cancelRefetch: false },
        ),
        queryClient.invalidateQueries(
          {
            queryKey: projectQueryKeys.workDraftMetadata(projectId, workId, documentId, itemKey),
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
    schedule.current = () => {
      const now = Date.now();
      if (timer === null) firstPendingAt = now;
      else clearTimeout(timer);
      timer = setTimeout(
        refresh,
        Math.min(SETTLE_MS, Math.max(0, firstPendingAt + MAX_WAIT_MS - now)),
      );
    };
    return () => {
      active = false;
      schedule.current = null;
      if (timer !== null) clearTimeout(timer);
    };
  }, [projectId, workId, documentId, itemKey, queryClient]);

  useEffect(() => {
    if (!runtime || !session) return;
    let active = true;
    const membership = (state: ReviewState) =>
      JSON.stringify([
        state.changes.length > 0,
        state.changes.some((change) => !change.attributed),
        [...new Set(state.changes.flatMap((change) => change.members))].sort(),
      ]);
    let previous: string | null = null;
    const changed = () => {
      const state = runtime.state();
      if (!state.ready) return;
      const next = membership(state);
      if (next === previous) return;
      previous = next;
      void session.whenCurrentChangesAcknowledged().then(
        () => {
          if (active) schedule.current?.();
        },
        () => {
          // A refused/retired binding cannot publish committed membership; its replacement discovers again.
        },
      );
    };
    const stop = runtime.subscribe(changed);
    changed();
    return () => {
      active = false;
      stop();
    };
  }, [runtime, session]);

  useEffect(() => {
    if (!liveSession) return;
    const changed = () => schedule.current?.();
    liveSession.document.on("update", changed);
    return () => liveSession.document.off("update", changed);
  }, [liveSession]);
}
