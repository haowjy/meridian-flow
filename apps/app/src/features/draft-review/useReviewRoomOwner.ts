/** The review's acquisition, generation observations and retained session binding. */
import { isCancelledError, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Dispatch, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { draftPreviewQueryOptions } from "@/client/query/useDraftPreview";
import { workDraftsQueryOptions } from "@/client/query/useWorkDrafts";
import type { DocumentSession } from "@/core/editor/document-session";
import { useLiveDocumentSessionRegistry } from "@/features/project/context/account-feature-context";
import type { DraftReviewAction, InlineDraftReview } from "./draft-review-session";
import { reviewChangesOfPreview } from "./review-changes";
import { reviewRoomRef } from "./review-room-ref";
import { draftClaim } from "./useReviewCommandCompletion";

let ownerSequence = 0;

export function useReviewRoomOwner({
  projectId,
  workId,
  review,
  dispatch,
  disposing,
  draftOnly = false,
}: {
  projectId: string;
  workId: string;
  review: InlineDraftReview | null;
  dispatch: Dispatch<DraftReviewAction>;
  disposing: boolean;
  draftOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const registry = useLiveDocumentSessionRegistry();
  const owner = useRef(`review-room:${++ownerSequence}`);
  const beforeReplace = useRef(new Set<() => void>());
  const prepareReplacement = useCallback(() => {
    for (const capture of beforeReplace.current) capture();
  }, []);
  const onBeforeReplace = useCallback((capture: () => void) => {
    beforeReplace.current.add(capture);
    return () => {
      beforeReplace.current.delete(capture);
    };
  }, []);
  const documentId = review?.documentId ?? "";
  const draftId = review?.draftId ?? "";
  const generation = review?.draftGeneration;
  const roomName = review?.roomName ?? null;
  const draft = { projectId, workId, documentId, draftId };
  const key = JSON.stringify([projectId, workId, documentId, draftId, generation, roomName]);
  const horizon = useRef({ key, queryClient, registry });
  horizon.current = { key, queryClient, registry };
  const { data: rows } = useQuery({ ...workDraftsQueryOptions(projectId, workId), enabled: false });
  const { data: preview } = useQuery({ ...draftPreviewQueryOptions(draft), enabled: false });
  const target = JSON.stringify([projectId, workId, documentId, draftId]);
  const kind = useRef({ target, queryClient, draftOnly });
  if (kind.current.target !== target || kind.current.queryClient !== queryClient)
    kind.current = { target, queryClient, draftOnly };
  const row = rows?.find((row) => row.draftId === draftId && row.documentId === documentId);
  // List omission after a close must not erase the draft-only destination's intent.
  if (draftOnly || row) kind.current.draftOnly = draftOnly || row?.isNewDocument === true;
  const selected = useRef(review);
  selected.current = review;
  const [binding, setBinding] = useState<{
    session: DocumentSession | null;
    key: string;
  }>({
    session: null,
    key: "",
  });
  const [painted, setPainted] = useState<DocumentSession | null>(null);
  const paintTarget = useRef<DocumentSession | null>(null);
  const reportPaint = useCallback((session: DocumentSession) => {
    if (paintTarget.current === session) setPainted(session);
  }, []);

  // One adapter weighs both caches together; list silence never precedes the
  // newer preview observation in this dispatch batch.
  useLayoutEffect(() => {
    if (!documentId || !draftId) return;
    const claim = draftClaim(queryClient, draft);
    const observations = reviewRoomObservations(rows, preview, draft);
    for (const action of observations) {
      if (
        action.type === "generationObserved" &&
        action.proposal &&
        generation !== undefined &&
        action.draftGeneration > generation
      )
        prepareReplacement();
      if (action.type !== "draftAbsentFromList" || (!review?.completion && !disposing))
        dispatch(action.type === "generationObserved" ? { ...action, claim } : action);
    }
    if (
      observations.some(
        (action) => action.type === "draftAbsentFromList" && action.evidence?.proposal,
      ) &&
      !review?.completion &&
      !disposing
    ) {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.workDraftPreview(projectId, workId, documentId, draftId),
      });
    }
  }, [
    rows,
    preview,
    projectId,
    workId,
    documentId,
    draftId,
    generation,
    review?.completion,
    disposing,
    queryClient,
    dispatch,
    prepareReplacement,
  ]);

  const wanted = Boolean(review && !roomName && !review.roomError);
  useEffect(() => {
    if (!wanted || !documentId || !draftId) return;
    let owned = true;
    const current = () =>
      owned &&
      horizon.current.key === key &&
      horizon.current.queryClient === queryClient &&
      horizon.current.registry === registry;
    const read = async () => {
      for (;;) {
        try {
          return await queryClient.fetchQuery({ ...draftPreviewQueryOptions(draft), staleTime: 0 });
        } catch (error) {
          if (!isCancelledError(error) || !current()) throw error;
        }
      }
    };
    void (async () => {
      let answer = await read();
      if (!current()) return;
      const shown = selected.current;
      if (
        answer.status === "active" &&
        shown?.draftGeneration !== undefined &&
        answer.draftGeneration < shown.draftGeneration
      )
        answer = await read();
      if (!current() || answer.status !== "active") return;
      dispatch({
        type: "generationObserved",
        documentId,
        draftId,
        draftGeneration: answer.draftGeneration,
        proposal: answer.inlineModelPresent && reviewChangesOfPreview(answer).length > 0,
        claim: draftClaim(queryClient, draft),
        roomName: answer.reviewRoomName,
      });
    })().catch(() => {
      if (current()) dispatch({ type: "roomFailed", documentId, draftId });
    });
    return () => {
      owned = false;
    };
  }, [
    wanted,
    key,
    projectId,
    workId,
    documentId,
    draftId,
    generation,
    queryClient,
    registry,
    dispatch,
  ]);

  useEffect(() => {
    if (!roomName || !documentId || !draftId) {
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
    const unavailable = () => {
      if (!current()) return;
      if (kind.current.draftOnly) {
        dispatch({ type: "roomStale", documentId, draftId, roomName });
        dispatch({ type: "roomFailed", documentId, draftId });
      } else dispatch({ type: "exitInline" });
    };
    let rebuilding = false;
    let unsubscribe: (() => void) | undefined;
    registry.retainBranchRooms(owner.current, [reviewRoomRef(queryClient, draft, roomName)]);
    const bind = (session: DocumentSession) => {
      if (!current()) return;
      setBinding((prior) =>
        prior.session === session && prior.key === key ? prior : { session, key },
      );
      unsubscribe = session.subscribe((snapshot) => {
        if (!current() || rebuilding) return;
        const connection = snapshot.connectionState;
        if (connection?.kind === "reset") {
          prepareReplacement();
          switch (connection.disposition) {
            case "superseded":
              rebuilding = true;
              setBinding({ session: null, key });
              dispatch({ type: "roomStale", documentId, draftId, roomName });
              return;
            case "rebuild":
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
                () => {
                  unavailable();
                },
              );
              return;
          }
        }
        if (
          snapshot.status === "destroyed" ||
          connection?.kind === "terminal" ||
          connection?.kind === "unauthorized" ||
          connection?.kind === "reset"
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
  }, [
    projectId,
    workId,
    documentId,
    draftId,
    roomName,
    key,
    registry,
    queryClient,
    dispatch,
    prepareReplacement,
  ]);

  const session =
    binding.key === key && binding.session?.roomKey === roomName ? binding.session : null;
  paintTarget.current = session;
  return {
    session,
    inputEligible:
      session !== null &&
      painted === session &&
      review !== null &&
      !review.roomError &&
      review.completion?.phase !== "closed",
    reportPaint,
    onBeforeReplace,
  } as const;
}

/** Addressed cache observations, without interpreting an empty reset as a proposal. */
export function reviewRoomObservations(
  rows: import("@meridian/contracts/drafts").ThreadDraftListItem[] | undefined,
  preview: import("@meridian/contracts/drafts").DraftPreviewResponse | undefined,
  draft: { documentId: string; draftId: string },
): DraftReviewAction[] {
  const actions: DraftReviewAction[] = [];
  const row = rows?.find(
    (row) => row.draftId === draft.draftId && row.documentId === draft.documentId,
  );
  if (row)
    actions.push({
      type: "generationObserved",
      ...draft,
      draftGeneration: row.draftGeneration,
      proposal: true,
    });
  const evidence =
    preview?.status === "active"
      ? {
          draftGeneration: preview.draftGeneration,
          proposal: preview.inlineModelPresent && reviewChangesOfPreview(preview).length > 0,
        }
      : null;
  if (evidence) actions.push({ type: "generationObserved", ...draft, ...evidence });
  if (rows && !row) actions.push({ type: "draftAbsentFromList", ...draft, evidence });
  return actions;
}

export type ReviewRoomOwner = ReturnType<typeof useReviewRoomOwner>;
