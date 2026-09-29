/**
 * Optimistic Work deletion with Undo, owned above the Work screen so the pane
 * chrome (the band's `…` menu) and the collection share one delete state.
 *
 * Each delete is its own record in the mutation cache: its Undo window, and
 * its failure, come from that record, so several deletes each keep their own.
 * The only local state is which Undo windows the writer closed while their
 * delete was still on its way; a pending record can't leave the cache.
 */
import type { Work } from "@meridian/contracts/works";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useCloseWorkDeleteWindow,
  useWorkCommandFailures,
  useWorkDeleteWindows,
  type WorkCommandFailure,
  type WorkDeleteWindow,
} from "@/client/query/work-command-selectors";
import { useWorkMutations } from "@/client/query/work-commands";
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
  const { delete: deleteCommand, restore } = useWorkMutations(projectId);
  const failures = useWorkCommandFailures(projectId, DELETE_OPERATIONS);
  const open = useWorkDeleteWindows(projectId);
  const closeSettled = useCloseWorkDeleteWindow(projectId);
  const [closed, setClosed] = useState<ReadonlySet<number>>(() => new Set());
  const windows = useMemo(() => open.filter((w) => !closed.has(w.mutationId)), [open, closed]);

  const close = useCallback(
    (targets: readonly WorkDeleteWindow[]) => {
      const pending = targets.filter((w) => w.pending).map((w) => w.mutationId);
      for (const w of targets) if (!w.pending) closeSettled(w.workId);
      if (pending.length) setClosed((current) => new Set([...current, ...pending]));
    },
    [closeSettled],
  );

  // A window closed while its delete was pending drops its record once it settles.
  useEffect(() => {
    if (!closed.size) return;
    const live = new Map(open.map((w) => [w.mutationId, w]));
    const settled = [...closed].filter((id) => !live.get(id)?.pending);
    if (!settled.length) return;
    for (const id of settled) {
      const w = live.get(id);
      if (w) closeSettled(w.workId);
    }
    setClosed((current) => new Set([...current].filter((id) => !settled.includes(id))));
  }, [open, closed, closeSettled]);

  // Opening another Work or starting a new one ends the Undo windows.
  const windowsRef = useRef(windows);
  windowsRef.current = windows;
  const routeWorkId = routeWorkIdentity(routeWork);
  const ending = routeWork.status === "new" || routeWork.status === "present";
  useEffect(() => {
    if (!ending) return;
    const others = windowsRef.current.filter((w) => w.workId !== routeWorkId);
    if (others.length) close(others);
  }, [ending, routeWorkId, close]);

  const remove = useCallback(
    (work: Work, from: "detail" | "list") => {
      if (from === "detail") void routeCommands.closeWork({ replace: true });
      void deleteCommand({ workId: work.id });
    },
    [deleteCommand, routeCommands],
  );
  const undo = useCallback((workId: string) => void restore({ workId }), [restore]);
  const dismiss = useCallback(
    (workId: string) => close(windows.filter((w) => w.workId === workId)),
    [close, windows],
  );
  return { windows, failures, remove, undo, dismiss };
}
