/**
 * One list of rows is one selection, one route for rows dropped on it and one
 * drop scope. The Files tree is one list over the project's areas, User is
 * one, a chat's Scratch one over the current and Earlier notes, and a Work's
 * Files one over its Scratch.
 * Shells declare the catalogs they show; this owns the rest: what a hovered
 * target would do, what a drop does, and what any move from the list (a drop
 * or Move…) leaves behind: the moved rows selected and a notice with Undo on
 * the list's surface, whose owner then keeps it (`move-notice.tsx`).
 */
import { t } from "@lingui/core/macro";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { useWorks } from "@/client/query/useWorks";
import type { NoticeSurface } from "../../shell/SurfaceNotice";
import {
  useAccountResourceProjection,
  useAccountResourceReplica,
} from "../account-feature-context";
import { destinationParent } from "../move-entry";
import { type EntriesRoute, type EntriesVerdict, TreeDropScope } from "../tree-drop/tree-drop";
import { activeEntryDrag } from "./drag-session";
import { type DragEntry, entryKey } from "./entry";
import { executeMove, type MoveResult, renamesOnArrival } from "./execute-move";
import { describeRenames, useMoveNotices } from "./move-notice";
import { type MoveArea, planMove, withoutNested } from "./move-plan";
import { type EntrySelection, EntrySelectionProvider, useEntrySelection } from "./selection";

/** Reports a finished move: selects what moved and leaves the notice. */
type ReportMove = (result: MoveResult, destinationName: string) => void;

type EntryListController = {
  selection: EntrySelection;
  route: EntriesRoute;
  moved: ReportMove;
};

const MovedContext = createContext<ReportMove | null>(null);

/** The list a row sits in, for Move… to report like a drop; null outside a list. */
export function useReportMove(): ReportMove | null {
  return useContext(MovedContext);
}

export function useEntryList({
  projectId,
  surface,
  areas,
}: {
  projectId: string;
  /** Where the list's move notices show. */
  surface: NoticeSurface;
  /** Every catalog this list shows; a target names its catalog by root ID. */
  areas: readonly MoveArea[];
}): EntryListController {
  const resources = useAccountResourceReplica();
  const { works, noWork } = useWorks(projectId);
  const projection = useAccountResourceProjection(projectId);
  const notices = useMoveNotices();
  // Hovers plan from the latest observation without remaking the route (and re-rendering every target).
  const prune = useCallback(
    (entries: DragEntry[]) => withoutNested(latest.current.projection, entries),
    [],
  );
  const selection = useEntrySelection(prune);
  const latest = useRef({ areas, projection, works, noWork, notices, selection });
  useLayoutEffect(() => {
    latest.current = { areas, projection, works, noWork, notices, selection };
  });

  const moved = useCallback<ReportMove>(
    (result, destinationName) => {
      const { notices, selection } = latest.current;
      if (result.moved.length > 0)
        selection.replace(result.moved.map((effect) => entryKey(effect.entry)));
      notices.publish(surface, result, destinationName, () => latest.current.selection.focus());
    },
    [surface],
  );

  const route = useMemo<EntriesRoute>(() => {
    const plan = (target: Parameters<EntriesRoute["verdict"]>[0]) => {
      const entries = activeEntryDrag();
      const { areas, projection } = latest.current;
      return entries ? planMove({ ...projection, areas }, entries, target) : null;
    };
    const judge = (target: Parameters<EntriesRoute["verdict"]>[0]): EntriesVerdict | null => {
      const planned = plan(target);
      if (planned?.kind === "inside-itself")
        return { kind: "refuse", label: t`Can't go inside itself` };
      if (planned?.kind !== "ready") return null;
      const { destinationName } = planned;
      const { works, noWork, projection } = latest.current;
      const after = destinationParent(planned.destination, works, noWork);
      const renamed = after
        ? renamesOnArrival(
            planned.moves.map(({ ref, name }) => ({ entry: ref, name, after })),
            projection,
          )
        : [];
      return {
        kind: "accept",
        label: t`Move to ${destinationName}`,
        warning: describeRenames(renamed),
      };
    };
    // `dragover` repeats many times a second over one target; its answer changes
    // only with the drag, the target or what the list shows.
    let last: { key: string; inputs: readonly unknown[]; verdict: EntriesVerdict | null } | null =
      null;
    return {
      verdict(target) {
        const { areas, projection, works, noWork } = latest.current;
        const key = `${target.catalogRootId}:${target.folder?.entryId ?? ""}`;
        const inputs = [activeEntryDrag(), areas, projection, works, noWork];
        if (last?.key === key && last.inputs.every((input, index) => input === inputs[index]))
          return last.verdict;
        const verdict = judge(target);
        last = { key, inputs, verdict };
        return verdict;
      },
      drop(target) {
        const planned = plan(target);
        if (planned?.kind !== "ready") return;
        const { works, noWork } = latest.current;
        const after = destinationParent(planned.destination, works, noWork);
        void executeMove(planned, after, { resources, projectId }).then((result) =>
          moved(result, planned.destinationName),
        );
      },
    };
  }, [resources, projectId, moved]);

  return useMemo(() => ({ selection, route, moved }), [selection, route, moved]);
}

/** Gives a list's rows and targets its selection and drop scope. */
export function EntryList({ list, children }: { list: EntryListController; children: ReactNode }) {
  return (
    <TreeDropScope route={list.route}>
      <EntrySelectionProvider selection={list.selection}>
        <MovedContext.Provider value={list.moved}>{children}</MovedContext.Provider>
      </EntrySelectionProvider>
    </TreeDropScope>
  );
}
