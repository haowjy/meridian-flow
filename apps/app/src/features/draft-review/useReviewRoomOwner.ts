/**
 * The open review's room: resolves where the draft lives (its metadata), holds that branch room for as
 * long as the review is open (`useBranchRoom`), and tells the review when the draft is gone. The review's text is the room's;
 * nothing here interprets it.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type Dispatch, useEffect, useRef } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { draftMetaQueryOptions, metaRoomName, useDraftMeta } from "@/client/query/useDraftMeta";
import { workDraftsQueryOptions } from "@/client/query/useWorkDrafts";
import type { PresentedDocument } from "@/features/project/presented-document";
import type { DraftReviewAction, InlineDraftReview } from "./draft-review-session";
import { useBranchRoom } from "./useBranchRoom";

export function useReviewRoomOwner({
  projectId,
  workId,
  review,
  dispatch,
  presented,
}: {
  projectId: string;
  workId: string;
  review: InlineDraftReview | null;
  dispatch: Dispatch<DraftReviewAction>;
  presented?: PresentedDocument | null;
}) {
  const draftOnly = presented?.draftOnly ?? false;
  const queryClient = useQueryClient();
  const documentId = review?.documentId ?? "";
  const itemKey = review?.itemKey ?? "";
  const draft = { projectId, workId, documentId, itemKey };
  const retry = review?.roomError ?? false;
  const { meta, failed } = useDraftMeta(draft, { enabled: review !== null });
  const roomName = metaRoomName(meta);

  // A draft-only destination keeps its presentation until the lifecycle settles it (`DraftOnlySettlement`).
  const kind = useRef({ target: "", draftOnly });
  const target = `${projectId}\u0000${workId}\u0000${documentId}\u0000${itemKey}`;
  if (kind.current.target !== target) kind.current = { target, draftOnly };
  if (draftOnly) kind.current.draftOnly = true;
  if (
    presented?.documentId === documentId &&
    presented.review?.itemKey === itemKey &&
    !presented.draftOnly
  )
    kind.current.draftOnly = false;

  const { data: rows } = useQuery({ ...workDraftsQueryOptions(projectId, workId), enabled: false });
  const listed = rows?.some((row) => row.itemKey === itemKey && row.documentId === documentId);
  // Closed is the metadata's 404 and nothing else: a list that omits the item says only "ask again".
  const gone = meta?.kind === "gone";

  useEffect(() => {
    if (!review) return;
    if (gone)
      dispatch({ type: "reviewAbsent", documentId, itemKey, draftOnly: kind.current.draftOnly });
    else if (failed) dispatch({ type: "roomFailed", documentId, itemKey });
  }, [review !== null, gone, failed, documentId, itemKey, dispatch, retry]);

  // A listed draft the writer's metadata no longer names (a closed draft) is read again, never assumed.
  useEffect(() => {
    if (!review || !rows || listed || !meta || meta.kind === "gone") return;
    void queryClient.invalidateQueries({
      queryKey: projectQueryKeys.workDraftMeta(projectId, workId, documentId, itemKey),
    });
  }, [
    review !== null,
    rows,
    listed,
    meta?.kind,
    queryClient,
    projectId,
    workId,
    documentId,
    itemKey,
  ]);

  // Closed or replaced rooms ask for the draft's metadata again; a schema reset keeps its session for the notice.
  const room = useBranchRoom(
    roomName && documentId && itemKey ? roomName : null,
    () => void queryClient.invalidateQueries({ queryKey: draftMetaQueryOptions(draft).queryKey }),
  );
  // A room that could not be opened fails the review like a failed metadata read; its Retry asks the room again.
  const roomFailed = room.state === "error";
  useEffect(() => {
    if (!review) return;
    if (roomFailed) dispatch({ type: "roomFailed", documentId, itemKey });
  }, [review !== null, roomFailed, documentId, itemKey, dispatch]);
  useEffect(() => {
    if (!retry && room.state === "error") room.retry();
  }, [retry]);
  return {
    session: room.session,
    roomName,
    inputEligible: room.usable !== null && review !== null && !review.roomError,
  } as const;
}

export type ReviewRoomOwner = ReturnType<typeof useReviewRoomOwner>;
