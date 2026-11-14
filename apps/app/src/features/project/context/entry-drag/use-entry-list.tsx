/**
 * One list of rows is one selection, one route for rows dropped on it and one
 * drop scope. The sidebar is one list over the project's areas, User and the
 * picked Work's Scratch, a chat's Scratch one over the current and Earlier
 * notes, and a Work's Files one over its Scratch.
 * Shells declare the trees they show; this owns the rest: what a hovered
 * target would do and what a drop does. A list row dropped within one system
 * moves at once; a drop across systems, and any other source (a chip, tab,
 * crumb, Recent row, receipt or Uploads entry), waits for the writer's choice
 * at the drop point, Move or Copy (see `drop-choice.ts`).
 */
import type { DocumentTrashEntry, ListDocumentTrashResponse } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useWorks } from "@/client/query/useWorks";
import { useOptionalContextRemovalCoordinator } from "../account-feature-context";
import { useDocumentTrashRestore } from "../DocumentTrashRestoreProvider";
import {
  type EntriesRoute,
  type EntriesVerdict,
  type FilesRoute,
  TreeDropScope,
  treeDropTargetKey,
} from "../tree-drop/tree-drop";
import { DropChoiceMenu, type DropChoiceState } from "./DropChoiceMenu";
import { activeDragSession } from "./drag-session";
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
import { useEntryActions } from "./entry-actions";
import { runCopy, runMove } from "./entry-failure";
import { renamesOnArrival } from "./execute-move";
import {
  type MoveArea,
  type MoveView,
  planMove,
  type ReadyCopy,
  type ReadyMove,
  resolveDrop,
} from "./move-plan";
import { planRestore, restoreLabel } from "./restore-drop";
import {
  type EntrySelection,
  EntrySelectionProvider,
  selectRows,
  useEntrySelection,
} from "./selection";

/** The trees and Works a drop is judged against. */
const moveView = (now: {
  areas: readonly MoveArea[];
  works: ReturnType<typeof useWorks>["works"];
  noWork: ReturnType<typeof useWorks>["noWork"];
}): MoveView => ({ areas: now.areas, works: now.works, noWork: now.noWork });

type EntryListController = {
  selection: EntrySelection;
  route: EntriesRoute;
  /** The menu a drop across systems waits on; null while none does. */
  choice: DropChoiceState | null;
};

export function useEntryList({
  projectId,
  areas,
}: {
  projectId: string;
  /** Every tree this list shows; a target names its tree by root ID. */
  areas: readonly MoveArea[];
}): EntryListController {
  const actions = useEntryActions(projectId);
  const removal = useOptionalContextRemovalCoordinator();
  const queryClient = useQueryClient();
  const { restoreInto } = useDocumentTrashRestore();
  const { works, noWork } = useWorks(projectId);
  const selection = useEntrySelection();
  const latest = useRef({ areas, works, noWork, selection });
  useLayoutEffect(() => {
    latest.current = { areas, works, noWork, selection };
  });

  const [pending, setPending] = useState<PendingChoice | null>(null);

  const runListMove = useCallback(
    (move: ReadyMove) =>
      void runMove({ actions, projectId, removal }, move.moves, move.destinationName, (moved) =>
        selectRows(latest.current.selection, moved),
      ),
    [actions, projectId, removal],
  );
  const runListCopy = useCallback(
    (copy: ReadyCopy) =>
      void runCopy({ actions, projectId, removal }, copy, (rows) =>
        selectRows(latest.current.selection, rows),
      ),
    [actions, projectId, removal],
  );

  const route = useMemo<EntriesRoute>(() => {
    const resolve = (target: Parameters<EntriesRoute["verdict"]>[0]) => {
      const drag = activeDragSession();
      if (!drag) return null;
      const view = moveView(latest.current);
      return { drag, resolved: resolveDrop(view, drag, target) };
    };
    // Trash rows the drag carries, as Trash lists them now; a row Trash no longer lists is gone.
    const trashed = (drag: NonNullable<ReturnType<typeof activeDragSession>>) => {
      const listed =
        queryClient.getQueryData<ListDocumentTrashResponse>(
          projectQueryKeys.documentTrash(projectId),
        )?.documents ?? [];
      const entries = drag.entries.flatMap(({ ref }) => {
        const found = listed.find(({ documentId }) => documentId === ref.id);
        return found ? [found] : [];
      });
      return entries.length === drag.entries.length ? entries : ([] as DocumentTrashEntry[]);
    };
    const judge = (target: Parameters<EntriesRoute["verdict"]>[0]): EntriesVerdict | null => {
      const dragging = activeDragSession();
      if (dragging?.source === "trash") {
        const plan = planRestore(moveView(latest.current), trashed(dragging), target);
        if (plan.kind === "refuse") return { kind: "refuse", label: plan.label };
        return plan.kind === "ready" ? { kind: "accept", label: restoreLabel(plan) } : null;
      }
      const drop = resolve(target);
      const resolved = drop?.resolved;
      if (!drop || !resolved) return null;
      if (resolved.unavailable.length > 0) return { kind: "refuse", label: noLongerThere() };
      if (resolved.insideItself) return { kind: "refuse", label: insideItself() };
      // A drop that asks offers what the menu would; the hint is the first thing it offers.
      if (resolved.asks) {
        const { items, plans } = dropChoices(resolved, target);
        const first = items.find((item) => item.enabled);
        if (!first) return null;
        // A move renames a row the writer already has; a copy is new, so it needs no warning.
        const moved = first.action === "move" ? (plans.move?.moves ?? []) : [];
        return {
          kind: "accept",
          label: askLabel(first.label),
          warning: describeRenames(renamesOnArrival(moved)),
        };
      }
      const planned = planMove(resolved);
      if (planned.kind !== "ready") return null;
      return {
        kind: "accept",
        label: moveLabel(planned),
        warning: describeRenames(renamesOnArrival(planned.moves)),
      };
    };
    // `dragover` repeats many times a second over one target; its answer changes
    // only with the drag, the target or what the list shows.
    let last: { key: string; inputs: readonly unknown[]; verdict: EntriesVerdict | null } | null =
      null;
    return {
      verdict(target) {
        const { areas, works, noWork } = latest.current;
        const key = treeDropTargetKey(target);
        const inputs = [activeDragSession(), areas, works, noWork];
        if (last?.key === key && last.inputs.every((input, index) => input === inputs[index]))
          return last.verdict;
        const verdict = judge(target);
        last = { key, inputs, verdict };
        return verdict;
      },
      drop(target, point) {
        const dragging = activeDragSession();
        if (dragging?.source === "trash") {
          const plan = planRestore(moveView(latest.current), trashed(dragging), target);
          if (plan.kind === "ready")
            restoreInto(plan.entries, plan.destination, plan.destinationName);
          return;
        }
        const drop = resolve(target);
        const resolved = drop?.resolved;
        if (!drop || !resolved) return;
        if (resolved.asks) {
          if (dropChoices(resolved, target).items.some((item) => item.enabled))
            // `dragend` clears the drag session after this, so the choice keeps the drag.
            setPending({
              drag: drop.drag,
              target,
              point,
              returnFocus: () => latest.current.selection.focus(),
            });
          return;
        }
        const planned = planMove(resolved);
        if (planned.kind === "ready") runListMove(planned);
      },
    };
  }, [projectId, queryClient, restoreInto, runListMove]);

  const choice = useMemo<DropChoiceState | null>(() => {
    if (!pending) return null;
    const choicesNow = (view: MoveView) =>
      dropChoices(resolveDrop(view, pending.drag, pending.target), pending.target);
    return {
      point: pending.point,
      returnFocus: pending.returnFocus,
      items: choicesNow(moveView({ areas, works, noWork })).items,
      choose(action: DropAction) {
        // Judged again from the trees now: the destination may have been renamed or removed.
        const { plans } = choicesNow(moveView(latest.current));
        if (action === "move" && plans.move) runListMove(plans.move);
        else if (action === "copy" && plans.copy) runListCopy(plans.copy);
      },
      dismiss: () => setPending(null),
    };
  }, [pending, areas, works, noWork, runListMove, runListCopy]);

  return useMemo(() => ({ selection, route, choice }), [selection, route, choice]);
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
        {children}
        {list.choice ? <DropChoiceMenu {...list.choice} /> : null}
      </EntrySelectionProvider>
    </TreeDropScope>
  );
}
