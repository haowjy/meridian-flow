/**
 * One list of rows is one selection, one route for rows dropped on it and one
 * drop scope. The Files tree is one list over the project's areas, User is
 * one, a chat's Scratch one over the current and Earlier notes, and a Work's
 * Files one over its Scratch.
 * Shells declare the catalogs they show; this owns the rest: what a hovered
 * target would do and what a drop does. A drop within one system moves at once;
 * one across systems waits for the writer's choice at the drop point, Move or
 * Copy (see `drop-choice.ts`). It also offers optional selection and focus
 * effects to Move… and Copy to…; the project-owned notice does not depend on a list.
 */
import { t } from "@lingui/core/macro";
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWorks } from "@/client/query/useWorks";
import { announceError } from "@/client/stores";
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
  treeDropTargetKey,
} from "../tree-drop/tree-drop";
import { copyOperation } from "./copy-operation";
import { DropChoiceMenu, type DropChoiceState } from "./DropChoiceMenu";
import { activeEntryDrag } from "./drag-session";
import {
  askLabel,
  type DropAction,
  describeRenames,
  dropChoices,
  insideItself,
  moveLabel,
  noLongerThere,
  type PendingChoice,
} from "./drop-choice";
import { type EntryRef, entryKey } from "./entry";
import { copyArrivals, copyRows } from "./execute-copy";
import { moveRows, renamesOnArrival } from "./execute-move";
import { moveOperation } from "./move-operation";
import {
  type MoveArea,
  type MoveView,
  planMove,
  type ReadyCopy,
  type ReadyMove,
  resolveDrop,
} from "./move-plan";
import { type Operation, OperationFeedbackProvider, useOperationNotices } from "./operation-notice";
import { type EntrySelection, EntrySelectionProvider, useEntrySelection } from "./selection";

type ListEffects = {
  select: (rows: readonly EntryRef[]) => void;
  refocus: () => void;
};

/** The placement and catalogs a drop is judged against. */
const moveView = (now: {
  areas: readonly MoveArea[];
  projection: ReturnType<typeof useAccountResourceProjection>;
  works: ReturnType<typeof useWorks>["works"];
  noWork: ReturnType<typeof useWorks>["noWork"];
}): MoveView => ({ ...now.projection, areas: now.areas, works: now.works, noWork: now.noWork });

type EntryListController = {
  selection: EntrySelection;
  route: EntriesRoute;
  feedback: ListEffects & { surface: NoticeSurface };
  /** The menu a drop across systems waits on; null while none does. */
  choice: DropChoiceState | null;
};

export function useEntryList({
  projectId,
  surface,
  areas,
}: {
  projectId: string;
  /** Where the list's notices show. */
  surface: NoticeSurface;
  /** Every catalog this list shows; a target names its catalog by root ID. */
  areas: readonly MoveArea[];
}): EntryListController {
  const resources = useAccountResourceReplica();
  const { works, noWork } = useWorks(projectId);
  const projection = useAccountResourceProjection(projectId);
  const notices = useOperationNotices();
  const selection = useEntrySelection();
  const latest = useRef({ areas, projection, works, noWork, selection });
  useLayoutEffect(() => {
    latest.current = { areas, projection, works, noWork, selection };
  });

  const listEffects = useMemo<ListEffects>(
    () => ({
      select(rows) {
        if (rows.length > 0) latest.current.selection.replace(rows.map(entryKey));
      },
      refocus: () => latest.current.selection.focus(),
    }),
    [],
  );

  const [pending, setPending] = useState<PendingChoice | null>(null);

  /** Reports an operation on `to`'s surface and selects its rows, the way Move… and Copy to… do. */
  const publish = useCallback(
    (operation: Operation, to: Pick<PendingChoice, "surface" | "returnFocus">) => {
      listEffects.select(operation.rows);
      notices.publish(to.surface, operation, to.returnFocus);
    },
    [notices, listEffects],
  );
  const runMove = useCallback(
    (move: ReadyMove, to: Pick<PendingChoice, "surface" | "returnFocus">) => {
      void moveRows(move.moves, { resources, projectId }).then((result) =>
        publish(moveOperation(result, move.destinationName), to),
      );
    },
    [resources, projectId, publish],
  );
  const runCopy = useCallback(
    (copy: ReadyCopy, to: Pick<PendingChoice, "surface" | "returnFocus">) => {
      void copyRows(copy, { resources, projectId }, to.surface).then((result) => {
        if (result) publish(copyOperation(result), to);
        else announceError(t`Couldn't copy these items`);
      });
    },
    [resources, projectId, publish],
  );

  const route = useMemo<EntriesRoute>(() => {
    const resolve = (target: Parameters<EntriesRoute["verdict"]>[0]) => {
      const entries = activeEntryDrag();
      if (!entries) return null;
      const view = moveView(latest.current);
      return { entries, view, resolved: resolveDrop(view, entries, target) };
    };
    const judge = (target: Parameters<EntriesRoute["verdict"]>[0]): EntriesVerdict | null => {
      const drop = resolve(target);
      const resolved = drop?.resolved;
      if (!drop || !resolved) return null;
      if (resolved.unavailable.length > 0) return { kind: "refuse", label: noLongerThere() };
      if (resolved.insideItself) return { kind: "refuse", label: insideItself() };
      const { view } = drop;
      // A crossing drop offers what the menu would; the hint is the first thing it offers.
      if (resolved.crossing) {
        const { items, plans } = dropChoices(view, resolved, target);
        const first = items.find((item) => item.enabled);
        if (!first) return null;
        const arrivals =
          first.action === "move"
            ? (plans.move?.moves ?? [])
            : plans.copy
              ? copyArrivals(plans.copy)
              : [];
        return {
          kind: "accept",
          label: askLabel(first.label),
          warning: describeRenames(renamesOnArrival(arrivals, view)),
        };
      }
      const planned = planMove(view, resolved);
      if (planned.kind !== "ready") return null;
      return {
        kind: "accept",
        label: moveLabel(planned),
        warning: describeRenames(renamesOnArrival(planned.moves, view)),
      };
    };
    // `dragover` repeats many times a second over one target; its answer changes
    // only with the drag, the target or what the list shows.
    let last: { key: string; inputs: readonly unknown[]; verdict: EntriesVerdict | null } | null =
      null;
    return {
      verdict(target) {
        const { areas, projection, works, noWork } = latest.current;
        const key = treeDropTargetKey(target);
        const inputs = [activeEntryDrag(), areas, projection, works, noWork];
        if (last?.key === key && last.inputs.every((input, index) => input === inputs[index]))
          return last.verdict;
        const verdict = judge(target);
        last = { key, inputs, verdict };
        return verdict;
      },
      drop(target, point) {
        const drop = resolve(target);
        const resolved = drop?.resolved;
        if (!drop || !resolved) return;
        const to = { surface, returnFocus: listEffects.refocus };
        if (resolved.crossing) {
          if (dropChoices(drop.view, resolved, target).items.some((item) => item.enabled))
            // `dragend` clears the drag session after this, so the choice keeps the entries.
            setPending({ entries: drop.entries, target, point, ...to });
          return;
        }
        const planned = planMove(drop.view, resolved);
        if (planned.kind === "ready") runMove(planned, to);
      },
    };
  }, [runMove, surface, listEffects]);

  const choice = useMemo<DropChoiceState | null>(() => {
    if (!pending) return null;
    const choicesNow = (view: MoveView) =>
      dropChoices(view, resolveDrop(view, pending.entries, pending.target), pending.target);
    return {
      point: pending.point,
      returnFocus: pending.returnFocus,
      items: choicesNow(moveView({ areas, projection, works, noWork })).items,
      choose(action: DropAction) {
        // Judged again from the replica now: the destination may have been renamed or removed.
        const { plans } = choicesNow(moveView(latest.current));
        if (action === "move" && plans.move) runMove(plans.move, pending);
        else if (action === "copy" && plans.copy) runCopy(plans.copy, pending);
      },
      dismiss: () => setPending(null),
    };
  }, [pending, areas, projection, works, noWork, runMove, runCopy]);

  const feedback = useMemo(() => ({ ...listEffects, surface }), [listEffects, surface]);
  return useMemo(
    () => ({ selection, route, feedback, choice }),
    [selection, route, feedback, choice],
  );
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
        <OperationFeedbackProvider feedback={list.feedback}>
          {children}
          {list.choice ? <DropChoiceMenu {...list.choice} /> : null}
        </OperationFeedbackProvider>
      </EntrySelectionProvider>
    </TreeDropScope>
  );
}
