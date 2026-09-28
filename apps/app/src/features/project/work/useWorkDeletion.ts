/**
 * Optimistic Work deletion with Undo, owned above the Work screen so the pane
 * chrome (the band's `…` menu) and the collection share one delete state.
 */
import { parseRequestId } from "@meridian/contracts/request-id";
import type { Work } from "@meridian/contracts/works";
import { useEffect, useState } from "react";
import { useWorkMutations } from "@/client/query/useWorks";
import type { ProjectRouteCommands, RouteWorkResolution } from "../routing/project-route";
import {
  emptyWorkDeleteState,
  type WorkDeleteState,
  workDeleteTransition,
} from "./work-delete-state";
import { holdWorkCollectionFocus } from "./work-focus-intent";

export type WorkDeletion = {
  state: WorkDeleteState;
  /** `detail` also leaves the Work page for the collection. */
  remove: (work: Work, from: "detail" | "list") => void;
  retry: () => void;
  undo: () => void;
  dismiss: () => void;
};

export function useWorkDeletion(
  projectId: string,
  routeWork: RouteWorkResolution,
  routeCommands: ProjectRouteCommands,
): WorkDeletion {
  const mutations = useWorkMutations(projectId);
  const [state, setState] = useState<WorkDeleteState>(emptyWorkDeleteState);
  const failed = () =>
    setState((current) => workDeleteTransition(current, { type: "delete-failed" }));
  const routeWorkId =
    routeWork.status === "present"
      ? routeWork.workId
      : routeWork.status === "unresolved"
        ? parseRequestId(routeWork.slug)
        : null;
  // Opening another Work or starting a new one ends the Undo window.
  useEffect(() => {
    if (routeWork.status === "new") {
      setState(emptyWorkDeleteState());
      return;
    }
    if (
      routeWork.status === "present" &&
      (state.failed || (state.deleted && routeWorkId !== state.deleted.id))
    ) {
      setState(emptyWorkDeleteState());
    }
  }, [state.deleted, state.failed, routeWork.status, routeWorkId]);
  return {
    state,
    remove: (work, from) => {
      setState((current) => workDeleteTransition(current, { type: "delete", work }));
      if (from === "detail") {
        holdWorkCollectionFocus(projectId, { kind: "heading" });
        void routeCommands.closeWork({ replace: true });
      }
      mutations.delete.mutate(work.id, { onError: failed });
    },
    retry: () => {
      const work = state.failed;
      if (!work) return;
      setState((current) => workDeleteTransition(current, { type: "retry" }));
      mutations.delete.mutate(work.id, { onError: failed });
    },
    undo: () => {
      const work = state.deleted;
      if (!work) return;
      setState((current) => workDeleteTransition(current, { type: "undo" }));
      mutations.restore.mutate(work.id, {
        onSuccess: () => setState(emptyWorkDeleteState()),
        onError: () =>
          setState((current) => workDeleteTransition(current, { type: "restore-failed" })),
      });
    },
    dismiss: () => setState(emptyWorkDeleteState()),
  };
}
