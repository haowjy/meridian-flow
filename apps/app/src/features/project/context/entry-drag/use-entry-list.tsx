/**
 * One list of rows is one selection, one route for rows dropped on it and one
 * drop scope. The Files tree is one list over the project's areas, User is
 * one, a chat's Scratch one over the current and Earlier notes, and a Work's
 * Files one over its Scratch.
 * Shells declare the catalogs they show; this owns the rest: what a hovered
 * target would do and what a drop does. It also offers optional selection and
 * focus effects to Move…; the project-owned notice does not depend on a list.
 */
import { t } from "@lingui/core/macro";
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { useWorks } from "@/client/query/useWorks";
import type { NoticeSurface } from "../../shell/SurfaceNotice";
import {
  useAccountResourceProjection,
  useAccountResourceReplica,
} from "../account-feature-context";
import {
  type EntriesRoute,
  type EntriesVerdict,
  type FilesRoute,
  TreeDropScope,
} from "../tree-drop/tree-drop";
import { activeEntryDrag } from "./drag-session";
import { entryKey } from "./entry";
import { type MoveResult, moveRows, renamesOnArrival } from "./execute-move";
import { describeRenames, MoveFeedbackProvider, useMoveNotices } from "./move-notice";
import { type MoveArea, planMove } from "./move-plan";
import { type EntrySelection, EntrySelectionProvider, useEntrySelection } from "./selection";

type ListMoveEffects = {
  select: (result: MoveResult) => void;
  refocus: () => void;
};

type EntryListController = {
  selection: EntrySelection;
  route: EntriesRoute;
  feedback: ListMoveEffects & { surface: NoticeSurface };
};

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
  const selection = useEntrySelection();
  const latest = useRef({ areas, projection, works, noWork, selection });
  useLayoutEffect(() => {
    latest.current = { areas, projection, works, noWork, selection };
  });

  const moveEffects = useMemo<ListMoveEffects>(
    () => ({
      select(result) {
        const { selection } = latest.current;
        if (result.moved.length > 0)
          selection.replace(result.moved.map((effect) => entryKey(effect.entry)));
      },
      refocus: () => latest.current.selection.focus(),
    }),
    [],
  );

  const reportDrop = useCallback(
    (result: MoveResult, destinationName: string) => {
      moveEffects.select(result);
      notices.publish(surface, result, destinationName, moveEffects.refocus);
    },
    [notices, surface, moveEffects],
  );

  const route = useMemo<EntriesRoute>(() => {
    const plan = (target: Parameters<EntriesRoute["verdict"]>[0]) => {
      const entries = activeEntryDrag();
      const { areas, projection, works, noWork } = latest.current;
      return entries ? planMove({ ...projection, areas, works, noWork }, entries, target) : null;
    };
    const judge = (target: Parameters<EntriesRoute["verdict"]>[0]): EntriesVerdict | null => {
      const planned = plan(target);
      if (planned?.kind === "inside-itself")
        return { kind: "refuse", label: t`Can't go inside itself` };
      if (planned?.kind !== "ready") return null;
      const { destinationName } = planned;
      const { projection } = latest.current;
      const renamed = renamesOnArrival(planned.moves, projection);
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
        void moveRows(planned.moves, { resources, projectId }).then((result) =>
          reportDrop(result, planned.destinationName),
        );
      },
    };
  }, [resources, projectId, reportDrop]);

  const feedback = useMemo(() => ({ ...moveEffects, surface }), [moveEffects, surface]);
  return useMemo(() => ({ selection, route, feedback }), [selection, route, feedback]);
}

/** Gives a list's rows and targets its selection and drop scope. */
export function EntryList({
  list,
  files,
  children,
}: {
  list: EntryListController;
  files?: FilesRoute;
  children: ReactNode;
}) {
  const routes = useMemo(() => ({ entries: list.route, files }), [list.route, files]);
  return (
    <TreeDropScope routes={routes}>
      <EntrySelectionProvider selection={list.selection}>
        <MoveFeedbackProvider feedback={list.feedback}>{children}</MoveFeedbackProvider>
      </EntrySelectionProvider>
    </TreeDropScope>
  );
}
