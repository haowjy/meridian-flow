/** The review's acquisition, generation observations and retained session binding. */
import { parseYjsRoomName } from "@meridian/contracts/protocol";
import { isCancelledError, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Dispatch, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { type DraftPreviewRead, draftPreviewQueryOptions } from "@/client/query/useDraftPreview";
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
  const documentId = review?.documentId ?? "";
  const draftId = review?.draftId ?? "";
  const generation = review?.draftGeneration;
  const roomName = review?.roomName ?? null;
  const draft = { projectId, workId, documentId, draftId, draftGeneration: generation };
  const key = JSON.stringify([projectId, workId, documentId, draftId, generation, roomName]);
  const horizon = useRef({ key, queryClient, registry });
  horizon.current = { key, queryClient, registry };
  const { data: rows } = useQuery({ ...workDraftsQueryOptions(projectId, workId), enabled: false });
  const { data: preview } = useQuery({ ...draftPreviewQueryOptions(draft), enabled: false });
  const [entryAnswered, setEntryAnswered] = useState<string | null>(null);
  const target = JSON.stringify([projectId, workId, documentId, draftId]);
  const writerScope = useRef({ target, queryClient, registry });
  if (
    writerScope.current.target !== target ||
    writerScope.current.queryClient !== queryClient ||
    writerScope.current.registry !== registry
  )
    writerScope.current = { target, queryClient, registry };
  const scope = writerScope.current;
  const [writerChanges, setWriterChanges] = useState({ scope, generation: null as number | null });
  const [outbox, setOutbox] = useState({ scope, generation: null as number | null });
  const pendingGenerations = [writerChanges, outbox]
    .filter((evidence) => evidence.scope === scope && evidence.generation !== null)
    .map((evidence) => evidence.generation as number);
  const pendingWriterGeneration = pendingGenerations.length
    ? Math.max(...pendingGenerations)
    : null;
  const kind = useRef({ target, queryClient, draftOnly });
  if (kind.current.target !== target || kind.current.queryClient !== queryClient)
    kind.current = { target, queryClient, draftOnly };
  const row = rows?.find((row) => row.draftId === draftId && row.documentId === documentId);
  // List omission after a close must not erase the draft-only destination's intent.
  if (draftOnly || row) kind.current.draftOnly = draftOnly || row?.isNewDocument === true;
  const selected = useRef({ review, pendingWriterGeneration });
  selected.current = { review, pendingWriterGeneration };
  const observeAbsence = (terminal = false, absenceGeneration = generation) => {
    const generation = selected.current.pendingWriterGeneration;
    dispatch({
      type: "reviewAbsent",
      documentId,
      draftId,
      terminal,
      draftGeneration: absenceGeneration,
      draftOnly: kind.current.draftOnly,
      evidence: generation === null ? null : { draftGeneration: generation, proposal: true },
    });
  };
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
    const observations = reviewRoomObservations(
      rows,
      preview,
      draft,
      pendingWriterGeneration,
      kind.current.draftOnly,
    );
    for (const action of observations) {
      if (
        action.type !== "reviewAbsent" ||
        (entryAnswered === target && !review?.completion && !disposing)
      )
        dispatch(action.type === "generationObserved" ? { ...action, claim } : action);
    }
    if (
      preview?.status !== "gone" &&
      observations.some((action) => action.type === "reviewAbsent" && action.evidence?.proposal) &&
      !review?.completion &&
      !disposing
    ) {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.workDraftPreview(projectId, workId, documentId, draftId),
      });
    }
  }, [
    entryAnswered,
    target,
    rows,
    preview,
    pendingWriterGeneration,
    projectId,
    workId,
    documentId,
    draftId,
    generation,
    review?.completion,
    disposing,
    queryClient,
    dispatch,
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
      const shown = selected.current.review;
      if (
        answer.draftGeneration !== undefined &&
        shown?.draftGeneration !== undefined &&
        answer.draftGeneration < shown.draftGeneration
      )
        answer = await read();
      if (!current()) return;
      setEntryAnswered(target);
      if (answer.status !== "gone")
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
      if (!current()) return;
      setEntryAnswered(target);
      dispatch({ type: "roomFailed", documentId, draftId });
    });
    return () => {
      owned = false;
    };
  }, [wanted, target, key, queryClient, registry, dispatch]);

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
      dispatch({ type: "roomStale", documentId, draftId, roomName });
      observeAbsence(true);
    };
    let rebuilding = false;
    let unsubscribe: (() => void) | undefined;
    registry.retainBranchRooms(owner.current, [
      {
        ...reviewRoomRef(queryClient, draft, roomName),
        writerChanges: (generation) => {
          // A carry outlives this binding, but never its addressed selection or account.
          if (writerScope.current === scope) setWriterChanges({ scope, generation });
        },
      },
    ]);
    const bind = (session: DocumentSession) => {
      if (!current()) return;
      setBinding((prior) =>
        prior.session === session && prior.key === key ? prior : { session, key },
      );
      unsubscribe = session.subscribe((snapshot) => {
        if (!current() || rebuilding) return;
        const connection = snapshot.connectionState;
        const room = parseYjsRoomName(roomName);
        setOutbox({
          scope,
          generation:
            room?.kind === "branch" &&
            connection?.kind !== "reset" &&
            session.hasUnacknowledgedEdits()
              ? room.generation
              : null,
        });
        if (connection?.kind === "reset") {
          switch (connection.disposition) {
            case "schema":
              // Keep the terminal session so its schema notice can paint.
              return;
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
  }, [key, scope, registry, queryClient, dispatch]);

  const session =
    binding.key === key && binding.session?.roomKey === roomName ? binding.session : null;
  paintTarget.current = session;
  return {
    session,
    inputEligible:
      session !== null &&
      painted === session &&
      session.getSnapshot().connectionState?.kind !== "reset" &&
      review !== null &&
      !review.roomError &&
      review.completion?.phase !== "closed",
    reportPaint,
  } as const;
}

/** Addressed cache observations, without interpreting an empty reset as a proposal. */
export function reviewRoomObservations(
  rows: import("@meridian/contracts/drafts").ThreadDraftListItem[] | undefined,
  preview: DraftPreviewRead | undefined,
  draft: { documentId: string; draftId: string },
  pendingWriterGeneration: number | null = null,
  draftOnly = false,
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
  // Delivery is changes evidence, not a listed proposal that adopts a generation.
  const changesEvidence =
    pendingWriterGeneration !== null &&
    (!evidence?.proposal || pendingWriterGeneration > evidence.draftGeneration)
      ? { draftGeneration: pendingWriterGeneration, proposal: true }
      : evidence;
  if ((rows && !row) || preview?.status === "gone")
    actions.push({
      type: "reviewAbsent",
      ...draft,
      draftGeneration: preview?.draftGeneration,
      evidence: changesEvidence,
      draftOnly: draftOnly && preview?.status === "gone",
    });
  return actions;
}

export type ReviewRoomOwner = ReturnType<typeof useReviewRoomOwner>;
