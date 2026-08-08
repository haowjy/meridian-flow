/** Sole controller connecting the Work binding reducer to query and announcements. */
import { t } from "@lingui/core/macro";
import type { Work } from "@meridian/contracts/works";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { isMeridianApiError } from "@/client/api/http-client";
import { ThreadWorkOutcomeUnconfirmedError } from "@/client/query/thread-work-binding-cache";
import { type NormalizedCommit, useRebindThreadWork } from "@/client/query/useRebindThreadWork";
import { useWorks } from "@/client/query/useWorks";
import { useAnnouncement } from "@/client/stores";
import {
  type ComposerWorkBindingState,
  initialComposerWorkBindingState,
  reduceComposerWorkBinding,
  type WorkBindingFailure,
  type WorkBindingRequest,
} from "./composer-work-binding-reducer";
import type { WorkCatalogView, WorkPickerOperation } from "./WorkPickerPanel";

export type ComposerWorkBindingController = {
  state: ComposerWorkBindingState;
  catalog: WorkCatalogView;
  operation: WorkPickerOperation;
  undoWork: Work | null;
  busy: boolean;
  canDismiss: boolean;
  open(): void;
  requestDismiss(): void;
  changeQuery(query: string): void;
  choose(work: Work): void;
  undo(): void;
  retryCatalog(): void;
};

export function useComposerWorkBinding({
  projectId,
  threadId,
  work,
}: {
  projectId: string;
  threadId: string;
  work: Work;
}): ComposerWorkBindingController {
  const [state, dispatch] = useReducer(
    reduceComposerWorkBinding,
    work,
    initialComposerWorkBindingState,
  );
  const worksQuery = useWorks(projectId);
  const mutation = useRebindThreadWork(projectId, threadId);
  const { announce, announceError } = useAnnouncement();
  const requestNumber = useRef(0);

  useEffect(() => {
    dispatch({
      type: "binding.observed",
      work,
      message: t`This chat's Work changed to ${work.name}`,
    });
  }, [work]);

  useEffect(() => {
    if (!state.effects.length) return;
    for (const item of state.effects) {
      if (item.type === "announce") announce(item.message);
      else if (item.type === "announceError") announceError(item.message);
      else worksQuery.refetch();
    }
    dispatch({ type: "effects.consumed", ids: state.effects.map(({ id }) => id) });
  }, [announce, announceError, state.effects, worksQuery.refetch]);

  const run = useCallback(
    async (target: Work, intent: "change" | "undo", origin: WorkBindingRequest["origin"]) => {
      if (mutation.isPending || target.id === state.observed.id) {
        if (target.id === state.observed.id) dispatch({ type: "panel.dismissed" });
        return;
      }
      const request: WorkBindingRequest = {
        id: `${threadId}:${++requestNumber.current}`,
        target,
        previousWorkId: state.observed.id,
        intent,
        origin,
        observedProjection: "none",
      };
      dispatch({ type: "change.started", request, message: t`Changing work to ${target.name}` });
      try {
        const outcome = await mutation.mutateAsync({
          targetWorkId: target.id,
          previousWorkId: state.observed.id,
        });
        if (outcome.kind === "superseded") {
          dispatch({
            type: "change.superseded",
            requestId: request.id,
            work: outcome.currentWork,
            message: t`This chat's Work changed to ${outcome.currentWork.name}`,
          });
          return;
        }
        if (outcome.kind === "reconciled_not_current") {
          dispatch({
            type: "change.notCurrent",
            requestId: request.id,
            message: t`The Work did not change. Try again.`,
          });
          return;
        }
        const result = outcome.result;
        const commit: NormalizedCommit = {
          threadId: result.threadId,
          previousWorkId: result.previousWorkId,
          work: result.work,
          changed: result.changed,
          preferenceChanged: result.preferenceChanged,
          undoWorkId: outcome.kind === "confirmed" ? outcome.undoWorkId : outcome.result.undoWorkId,
        };
        dispatch({
          type: "change.committed",
          requestId: request.id,
          commit,
          message: commit.preferenceChanged
            ? t`This chat now uses ${commit.work.name}. New chats will use it too.`
            : t`This chat now uses ${commit.work.name}.`,
        });
      } catch (cause) {
        let failure: WorkBindingFailure;
        let message: string;
        if (isMeridianApiError(cause) && cause.code === "thread_busy") {
          failure = { kind: "thread_busy" };
          message = t`Wait for this response to finish, then try again.`;
        } else if (isMeridianApiError(cause) && cause.code === "work_unavailable") {
          failure = { kind: "work_unavailable" };
          message = t`That Work is no longer available. Choose another Work.`;
          worksQuery.refetch();
        } else if (isMeridianApiError(cause) && cause.code === "thread_work_missing") {
          failure = { kind: "current_work_missing" };
          message = t`This chat's current Work could not be found. Refresh the page and try again.`;
        } else {
          failure = { kind: "unconfirmed" };
          message =
            cause instanceof ThreadWorkOutcomeUnconfirmedError
              ? t`The change could not be confirmed. Try again.`
              : t`The change could not be confirmed. Try again.`;
        }
        dispatch({ type: "change.refused", requestId: request.id, failure, message });
      }
    },
    [mutation, state.observed.id, threadId, worksQuery.refetch],
  );

  const allWorks = worksQuery.works ?? [];
  const catalog: WorkCatalogView =
    worksQuery.status === "loading" || worksQuery.status === "disabled"
      ? { status: "loading" }
      : worksQuery.status === "error"
        ? { status: "error", retry: worksQuery.refetch }
        : worksQuery.status === "empty"
          ? { status: "empty" }
          : { status: "ready", works: allWorks, refreshing: worksQuery.isFetching };
  const undoWork = allWorks.find(({ id }) => id === state.undo?.workId) ?? null;
  const busy = state.view.kind === "changing";
  const operation: WorkPickerOperation = {
    currentWorkId: state.observed.id,
    targetId:
      state.view.kind === "changing"
        ? state.view.request.target.id
        : state.view.kind === "refused"
          ? state.view.targetId
          : null,
    pending: busy,
    failure: state.view.kind === "refused" ? state.view.failure : null,
  };
  return {
    state,
    catalog,
    operation,
    undoWork,
    busy,
    canDismiss: !busy,
    open: () => dispatch({ type: "panel.opened" }),
    requestDismiss: () => dispatch({ type: "panel.dismissed" }),
    changeQuery: (query) => dispatch({ type: "query.changed", query }),
    choose: (target) => void run(target, "change", "panel"),
    undo: () => {
      if (undoWork) void run(undoWork, "undo", "undo");
    },
    retryCatalog: worksQuery.refetch,
  };
}
