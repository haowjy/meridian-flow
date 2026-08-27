/** Sole controller connecting the Work binding reducer to query and announcements. */
import { t } from "@lingui/core/macro";
import type { Work } from "@meridian/contracts/works";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { isMeridianApiError } from "@/client/api/http-client";
import { ThreadWorkOutcomeUnconfirmedError } from "@/client/query/thread-work-binding-cache";
import { type NormalizedCommit, useRebindThreadWork } from "@/client/query/useRebindThreadWork";
import { useWorks } from "@/client/query/useWorks";
import { useAnnouncement } from "@/client/stores";
import type { WorkCatalogView, WorkPickerOperation } from "@/components/app/work-composer-controls";
import {
  type ComposerWorkBindingState,
  initialComposerWorkBindingState,
  reduceComposerWorkBinding,
  type WorkBindingFailure,
  type WorkBindingRequest,
} from "./composer-work-binding-reducer";

export type ComposerWorkBindingController = {
  state: ComposerWorkBindingState;
  catalog: WorkCatalogView;
  operation: WorkPickerOperation;
  busy: boolean;
  changeQuery(query: string): void;
  choose(work: Work): Promise<"close" | "stay">;
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
    async (target: Work) => {
      if (mutation.isPending || target.id === state.observed.id) {
        return target.id === state.observed.id ? ("close" as const) : ("stay" as const);
      }
      const request: WorkBindingRequest = {
        id: `${threadId}:${++requestNumber.current}`,
        target,
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
          return "close" as const;
        }
        if (outcome.kind === "reconciled_not_current") {
          dispatch({
            type: "change.notCurrent",
            requestId: request.id,
            message: t`The Work did not change. Try again.`,
          });
          return "stay" as const;
        }
        const result = outcome.result;
        const commit: NormalizedCommit = {
          threadId: result.threadId,
          work: result.work,
          changed: result.changed,
        };
        dispatch({
          type: "change.committed",
          requestId: request.id,
          commit,
          message: t`This chat now uses ${commit.work.name}.`,
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
        return "stay" as const;
      }
      return "close" as const;
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
    busy,
    changeQuery: (query) => dispatch({ type: "query.changed", query }),
    choose: run,
    retryCatalog: worksQuery.refetch,
  };
}
