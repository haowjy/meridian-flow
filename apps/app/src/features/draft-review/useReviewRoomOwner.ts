/**
 * The open review's room: resolves where the draft lives (its metadata), retains that branch room for as
 * long as the review is open, and tells the review when the draft is gone. The review's text is the room's;
 * nothing here interprets it.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type Dispatch, useEffect, useRef, useState } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { draftMetaQueryOptions, metaRoomName, useDraftMeta } from "@/client/query/useDraftMeta";
import { workDraftsQueryOptions } from "@/client/query/useWorkDrafts";
import type { DocumentSession } from "@/core/editor/document-session";
import { useLiveDocumentSessionRegistry } from "@/features/project/context/account-feature-context";
import type { PresentedDocument } from "@/features/project/presented-document";
import type { DraftReviewAction, InlineDraftReview } from "./draft-review-session";

let ownerSequence = 0;

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
  const registry = useLiveDocumentSessionRegistry();
  const owner = useRef(`review-room:${++ownerSequence}`);
  const documentId = review?.documentId ?? "";
  const itemKey = review?.itemKey ?? "";
  const draft = { projectId, workId, documentId, itemKey };
  const retry = review?.roomError ?? false;
  const { meta, failed } = useDraftMeta(draft, { enabled: review !== null });
  const roomName = metaRoomName(meta);
  const key = JSON.stringify([projectId, workId, documentId, itemKey, roomName]);
  const horizon = useRef({ key, queryClient, registry });
  horizon.current = { key, queryClient, registry };

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

  const [binding, setBinding] = useState<{ session: DocumentSession | null; key: string }>({
    session: null,
    key: "",
  });
  useEffect(() => {
    if (!roomName || !documentId || !itemKey) {
      setBinding((prior) =>
        prior.session === null && prior.key === key ? prior : { session: null, key },
      );
      return;
    }
    let owned = true;
    const current = () =>
      owned &&
      horizon.current.key === key &&
      horizon.current.queryClient === queryClient &&
      horizon.current.registry === registry;
    // The room is unusable: the draft may have a new room or be closed, so ask again.
    const unavailable = () => {
      if (!current()) return;
      void queryClient.invalidateQueries({
        queryKey: draftMetaQueryOptions(draft).queryKey,
      });
    };
    let rebuilding = false;
    let unsubscribe: (() => void) | undefined;
    registry.retainBranchRooms(owner.current, [roomName]);
    const bind = (session: DocumentSession) => {
      if (!current()) return;
      setBinding((prior) =>
        prior.session === session && prior.key === key ? prior : { session, key },
      );
      unsubscribe = session.subscribe((snapshot) => {
        if (!current() || rebuilding) return;
        const connection = snapshot.connectionState;
        if (connection?.kind === "reset") {
          switch (connection.disposition) {
            case "schema":
              // Keep the terminal session so its schema notice can paint.
              return;
            case "superseded":
              // The draft closed (Apply or Discard of the whole draft): ask what it is now.
              rebuilding = true;
              setBinding({ session: null, key });
              unavailable();
              return;
            case "refused":
              rebuilding = true;
              setBinding({ session: null, key });
              void registry.rebuildBranchRoom(roomName).then(
                (replacement) => {
                  if (!current()) return;
                  unsubscribe?.();
                  rebuilding = false;
                  bind(replacement);
                },
                () => unavailable(),
              );
              return;
          }
        }
        if (
          snapshot.status === "destroyed" ||
          connection?.kind === "terminal" ||
          connection?.kind === "unauthorized"
        ) {
          setBinding((prior) =>
            prior.session === null && prior.key === key ? prior : { session: null, key },
          );
          unavailable();
        }
      });
    };
    try {
      bind(registry.getBranchRoom(roomName));
    } catch (error) {
      registry.releaseBranchRooms(owner.current);
      throw error;
    }
    return () => {
      owned = false;
      unsubscribe?.();
      registry.releaseBranchRooms(owner.current);
    };
  }, [key, registry, queryClient]);

  const session =
    binding.key === key && binding.session?.roomKey === roomName ? binding.session : null;
  return {
    session,
    roomName,
    inputEligible:
      session !== null &&
      session.getSnapshot().connectionState?.kind !== "reset" &&
      review !== null &&
      !review.roomError,
  } as const;
}

export type ReviewRoomOwner = ReturnType<typeof useReviewRoomOwner>;
