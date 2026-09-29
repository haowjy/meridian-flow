/**
 * Optimistic Work deletion with Undo, owned above the Work screen so the pane
 * chrome (the band's `…` menu) and the collection share one delete state.
 *
 * Each delete is its own command record: its Undo window, and its failure,
 * come from that record, so several deletes each keep their own, and closing
 * a window reaches every surface.
 */
import type { Work } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import {
  useWorkCommandFailures,
  useWorkDeleteWindows,
  type WorkCommandFailure,
  type WorkDeleteWindow,
} from "@/client/query/work-command-selectors";
import { closeWorkDeleteWindow, useWorkMutations } from "@/client/query/work-commands";
import type { ProjectRouteCommands, RouteWorkResolution } from "../routing/project-route";
import { routeWorkIdentity } from "./route-work-identity";

export type WorkDeletion = {
  /** Open Undo windows, oldest delete first. */
  windows: readonly WorkDeleteWindow[];
  /** Rejected deletes, keyed by Work id. */
  failures: ReadonlyMap<string, WorkCommandFailure<"delete">>;
  /** `detail` also leaves the Work page for the collection. */
  remove: (work: Work, from: "detail" | "list") => void;
  undo: (workId: string) => void;
  dismiss: (workId: string) => void;
};

const DELETE_OPERATIONS = ["delete"] as const;

export function useWorkDeletion(
  projectId: string,
  routeWork: RouteWorkResolution,
  routeCommands: ProjectRouteCommands,
): WorkDeletion {
  const client = useQueryClient();
  const { delete: deleteCommand, restore } = useWorkMutations(projectId);
  const failures = useWorkCommandFailures(projectId, DELETE_OPERATIONS);
  const windows = useWorkDeleteWindows(projectId);
  const close = useCallback(
    (workId: string) => closeWorkDeleteWindow(client, projectId, workId),
    [client, projectId],
  );

  // Opening another Work or starting a new one ends the Undo windows.
  const windowsRef = useRef(windows);
  windowsRef.current = windows;
  const routeWorkId = routeWorkIdentity(routeWork);
  const ending = routeWork.status === "new" || routeWork.status === "present";
  useEffect(() => {
    if (!ending) return;
    for (const open of windowsRef.current) if (open.workId !== routeWorkId) close(open.workId);
  }, [ending, routeWorkId, close]);

  const remove = useCallback(
    (work: Work, from: "detail" | "list") => {
      if (from === "detail") void routeCommands.closeWork({ replace: true });
      void deleteCommand({ workId: work.id });
    },
    [deleteCommand, routeCommands],
  );
  const undo = useCallback((workId: string) => void restore({ workId }), [restore]);
  return { windows, failures, remove, undo, dismiss: close };
}
