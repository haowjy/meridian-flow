/** The review's acquisition, generation observations and retained session binding. */

import { parseYjsRoomName } from "@meridian/contracts/protocol";
import { isCancelledError, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Dispatch, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type ChangeCommandRecords,
  currentChangeCommandRecords,
  intentKeys,
  useChangeCommandRecords,
  wholeDraftDisposition,
} from "@/client/query/branch-command-record";
import { projectDraft, projectDraftList } from "@/client/query/draft-projection";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { type DraftPreviewRead, draftPreviewQueryOptions } from "@/client/query/useDraftPreview";
import { workBranchDraftsQueryOptions } from "@/client/query/useWorkBranchDrafts";
import { type DocumentSession, updatesRefused } from "@/core/editor/document-session";
import { useLiveDocumentSessionRegistry } from "@/features/project/context/account-feature-context";
import { useRemovedRoomCheck } from "@/features/project/context/use-removed-room-check";
import type { PresentedDocument } from "@/features/project/presented-document";
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
  presented,
}: {
  projectId: string;
  workId: string;
  review: InlineDraftReview | null;
  dispatch: Dispatch<DraftReviewAction>;
  disposing: boolean;
  presented?: PresentedDocument | null;
}) {
  const draftOnly = presented?.draftOnly ?? false;
  const queryClient = useQueryClient();
  const registry = useLiveDocumentSessionRegistry();
  const owner = useRef(`review-room:${++ownerSequence}`);
  const documentId = review?.documentId ?? "";
  const itemKey = review?.itemKey ?? "";
  const generation = review?.draftGeneration;
  const roomName = review?.roomName ?? null;
  const draft = { projectId, workId, documentId, itemKey, draftGeneration: generation };
  const key = JSON.stringify([projectId, workId, documentId, itemKey, generation, roomName]);
  const horizon = useRef({ key, queryClient, registry });
  horizon.current = { key, queryClient, registry };
  const { data: rows } = useQuery({
    ...workBranchDraftsQueryOptions(projectId, workId),
    enabled: false,
  });
  const { data: preview } = useQuery({ ...draftPreviewQueryOptions(draft), enabled: false });
  const records = useChangeCommandRecords();
  const [entryAnswered, setEntryAnswered] = useState<string | null>(null);
  const target = JSON.stringify([projectId, workId, documentId, itemKey]);
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
  const row = rows?.find((row) => row.itemKey === itemKey && row.documentId === documentId);
  // List omission after a close must not erase the draft-only destination's intent.
  if (draftOnly || row) kind.current.draftOnly = draftOnly || row?.isNew === true;
  // Only a resolved live presentation of this exact review proves promotion.
  // A pending or nonmatching address says nothing about its remaining overlay.
  const promoted =
    presented?.documentId === documentId &&
    presented.review?.workId === workId &&
    presented.review.itemKey === itemKey &&
    !presented.draftOnly;
  if (promoted) kind.current.draftOnly = false;
  const selected = useRef({ review, pendingWriterGeneration });
  selected.current = { review, pendingWriterGeneration };
  const observeAbsence = (terminal = false, absenceGeneration = generation) => {
    const generation = selected.current.pendingWriterGeneration;
    dispatch({
      type: "reviewAbsent",
      documentId,
      itemKey,
      terminal,
      draftGeneration: absenceGeneration,
      draftOnly: kind.current.draftOnly,
      evidence: generation === null ? null : { draftGeneration: generation, proposal: true },
    });
  };
  const reopenRoom = useRef<(() => void) | null>(null);
  const [binding, setBinding] = useState<{
    session: DocumentSession | null;
    key: string;
  }>({
    session: null,
    key: "",
  });
  // One adapter weighs both caches together; list silence never precedes the
  // newer preview observation in this dispatch batch.
  useLayoutEffect(() => {
    if (!documentId || !itemKey) return;
    const claim = draftClaim(queryClient, draft);
    const observations = reviewRoomObservations(
      rows,
      preview,
      draft,
      pendingWriterGeneration,
      kind.current.draftOnly,
      { scope: { projectId, workId }, records },
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
        queryKey: projectQueryKeys.workDraftPreview(projectId, workId, documentId, itemKey),
      });
    }
  }, [
    entryAnswered,
    target,
    rows,
    preview,
    records,
    draftOnly,
    promoted,
    pendingWriterGeneration,
    projectId,
    workId,
    documentId,
    itemKey,
    generation,
    review?.completion,
    disposing,
    queryClient,
    dispatch,
  ]);

  const wanted = Boolean(review && !roomName && !review.roomError);
  useEffect(() => {
    if (!wanted || !documentId || !itemKey) return;
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
      if (answer.status === "corrupt") dispatch({ type: "roomFailed", documentId, itemKey });
      if (answer.status === "active") {
        const records = currentChangeCommandRecords();
        const visible = projectDraft(
          answer,
          intentKeys(records, draft),
          wholeDraftDisposition(records, draft, answer.draftGeneration, answer) !== null,
        ).preview;
        dispatch({
          type: "generationObserved",
          documentId,
          itemKey,
          draftGeneration: answer.draftGeneration,
          proposal: visible.status === "active" && reviewChangesOfPreview(visible).length > 0,
          claim: draftClaim(queryClient, draft),
          roomName: answer.reviewRoomName,
        });
      }
    })().catch(() => {
      if (!current()) return;
      setEntryAnswered(target);
      dispatch({ type: "roomFailed", documentId, itemKey });
    });
    return () => {
      owned = false;
    };
  }, [wanted, target, key, queryClient, registry, dispatch]);

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
    const unavailable = () => {
      if (!current()) return;
      dispatch({ type: "roomStale", documentId, itemKey, roomName });
      observeAbsence(true);
    };
    let rebuilding = false;
    let unsubscribe: (() => void) | undefined;
    // Reopen the room from the server's state; a re-forked draft answers that
    // reconnect as superseded and the review moves to its new generation.
    const rebuild = () => {
      rebuilding = true;
      setBinding({ session: null, key });
      void registry.rebuildDraftRoom(roomName).then(
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
    };
    reopenRoom.current = () => {
      if (current() && !rebuilding) rebuild();
    };
    registry.retainDraftRooms(owner.current, [
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
            room?.kind === "draft" &&
            connection?.kind !== "reset" &&
            !updatesRefused(connection) &&
            session.hasUnacknowledgedEdits()
              ? room.generation
              : null,
        });
        if (connection?.kind === "reset") {
          switch (connection.disposition) {
            case "schema":
              // Keep the terminal session so its schema notice can paint.
              return;
            case "removed":
              // The document is gone: keep the terminal session, read-only, until
              // availability closes the tab or the writer does (`removedCheck`).
              return;
            case "superseded":
              rebuilding = true;
              setBinding({ session: null, key });
              dispatch({ type: "roomStale", documentId, itemKey, roomName });
              return;
            case "rebuild":
            case "refused":
              rebuild();
              return;
          }
        }
        // Stays bound and read-only: the writer copies the unsent text, then reopens.
        if (updatesRefused(connection)) return;
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
      bind(registry.getDraftRoom(roomName));
    } catch (error) {
      registry.releaseDraftRooms(owner.current);
      throw error;
    }
    return () => {
      owned = false;
      reopenRoom.current = null;
      unsubscribe?.();
      registry.releaseDraftRooms(owner.current);
    };
  }, [key, scope, registry, queryClient, dispatch]);

  const session =
    binding.key === key && binding.session?.roomKey === roomName ? binding.session : null;
  // The server closed the draft room because its document was removed: the
  // lookup closes the tab with the record; the Work's drafts drop the closed draft.
  const removedCheck = useRemovedRoomCheck(projectId, documentId, session);
  useEffect(() => {
    if (removedCheck)
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.workBranchDrafts(projectId, workId),
      });
  }, [projectId, queryClient, removedCheck, workId]);
  return {
    session,
    /** The writer's unsent edits of a retired generation have not all reached the room yet. */
    carryPending: writerChanges.scope === scope && writerChanges.generation !== null,
    /** Reopens a room whose updates the server kept refusing at the draft's current state. */
    reopen: () => reopenRoom.current?.(),
    inputEligible:
      session !== null &&
      session.getSnapshot().connectionState?.kind !== "reset" &&
      !updatesRefused(session.getSnapshot().connectionState) &&
      review !== null &&
      !review.roomError &&
      review.completion?.phase !== "closed",
  } as const;
}

/** Addressed cache observations, without interpreting an empty reset as a proposal. */
export function reviewRoomObservations(
  rows: import("@meridian/contracts/branches").ThreadDraftListItem[] | undefined,
  preview: DraftPreviewRead | undefined,
  draft: { documentId: string; itemKey: string },
  pendingWriterGeneration: number | null = null,
  draftOnly = false,
  intents?: { scope: { projectId: string; workId: string }; records: ChangeCommandRecords },
): DraftReviewAction[] {
  const actions: DraftReviewAction[] = [];
  const row = rows?.find(
    (row) => row.itemKey === draft.itemKey && row.documentId === draft.documentId,
  );
  const visibleRows =
    intents && rows ? projectDraftList(rows, intents.scope, intents.records) : rows;
  const visiblePreview =
    intents && preview
      ? projectDraft(
          preview,
          intentKeys(intents.records, { ...intents.scope, ...draft }),
          wholeDraftDisposition(
            intents.records,
            { ...intents.scope, ...draft },
            preview.draftGeneration,
            preview,
          ) !== null,
        ).preview
      : preview;
  if (row && row.draftGeneration !== null)
    actions.push({
      type: "generationObserved",
      ...draft,
      draftGeneration: row.draftGeneration,
      proposal: visibleRows?.includes(row) === true,
    });
  const evidence =
    preview?.status === "active"
      ? {
          draftGeneration: preview.draftGeneration,
          proposal:
            visiblePreview?.status === "active" &&
            reviewChangesOfPreview(visiblePreview).length > 0,
        }
      : null;
  if (evidence) actions.push({ type: "generationObserved", ...draft, ...evidence });
  // Delivery is changes evidence, not a listed proposal that adopts a generation.
  const changesEvidence =
    pendingWriterGeneration !== null &&
    (!evidence?.proposal || pendingWriterGeneration > evidence.draftGeneration)
      ? { draftGeneration: pendingWriterGeneration, proposal: true }
      : evidence;
  // A draft-only address belongs to lifecycle until catalog settlement. List
  // omission and an empty active/reset preview cannot close or fail it.
  if (preview?.status === "gone" || (preview?.status !== "corrupt" && !draftOnly && rows && !row))
    actions.push({
      type: "reviewAbsent",
      ...draft,
      draftGeneration: preview?.draftGeneration,
      evidence: changesEvidence,
      draftOnly,
    });
  return actions;
}

export type ReviewRoomOwner = ReturnType<typeof useReviewRoomOwner>;
