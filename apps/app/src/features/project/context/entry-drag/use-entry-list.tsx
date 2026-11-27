import type { DocumentId } from "@meridian/contracts/runtime";
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type TrashEntry, useTrashRows } from "@/client/query/useDocumentTrash";
import {
  useOptionalContextRemovalCoordinator,
  useOptionalLiveDocumentSessionRegistry,
} from "../account-feature-context";
import { useDocumentTrashRestore } from "../DocumentTrashRestoreProvider";
import {
  type EntriesRoute,
  type EntriesVerdict,
  type FilesRoute,
  TreeDropScope,
  treeDropTargetKey,
} from "../tree-drop/tree-drop";
import { revealPlaced } from "../tree-reveal";
import { DropChoiceMenu, type DropChoiceState } from "./DropChoiceMenu";
import { activeDragSession } from "./drag-session";
import {
  askLabel,
  type DropAction,
  dropChoices,
  insideItself,
  moveLabel,
  noLongerThere,
  type PendingChoice,
} from "./drop-choice";
import { trashRef } from "./entry";
import { useEntryActions } from "./entry-actions";
import { runCopy, runMove } from "./entry-failure";
import {
  type MoveArea,
  type PlacementView,
  planMove,
  type ReadyCopy,
  type ReadyMove,
  resolveDrop,
} from "./move-plan";
import { planRestore, restoreLabel } from "./restore-drop";
import { type EntrySelection, EntrySelectionProvider, useEntrySelection } from "./selection";

type EntryListController = {
  selection: EntrySelection;
  route: EntriesRoute;
  choice: DropChoiceState | null;
};

export function useEntryList({
  projectId,
  areas,
}: {
  projectId: string;
  areas: readonly MoveArea[];
}): EntryListController {
  const actions = useEntryActions(projectId);
  const removal = useOptionalContextRemovalCoordinator();
  const registry = useOptionalLiveDocumentSessionRegistry();
  const roomVersionOf = useCallback(
    (documentId: string) => registry?.openRoomVersion(documentId as DocumentId) ?? null,
    [registry],
  );
  const { restoreInto } = useDocumentTrashRestore();
  const selection = useEntrySelection();
  const trashRows = useTrashRows(projectId);
  const latest = useRef({ areas, selection, trashRows });
  useLayoutEffect(() => {
    latest.current = { areas, selection, trashRows };
  });

  const [pending, setPending] = useState<PendingChoice | null>(null);

  const runListMove = useCallback(
    (move: ReadyMove) => runMove({ actions, projectId, removal }, move, latest.current.selection),
    [actions, projectId, removal],
  );
  const runListCopy = useCallback(
    (copy: ReadyCopy) =>
      void runCopy({ actions, projectId, removal, roomVersionOf }, copy, latest.current.selection),
    [actions, projectId, removal, roomVersionOf],
  );

  const route = useMemo<EntriesRoute>(() => {
    const resolve = (target: Parameters<EntriesRoute["verdict"]>[0]) => {
      const drag = activeDragSession();
      if (!drag) return null;
      const view = latest.current;
      return { drag, resolved: resolveDrop(view, drag, target) };
    };
    const trashed = (drag: NonNullable<ReturnType<typeof activeDragSession>>) => {
      const listed = latest.current.trashRows ?? [];
      const entries = drag.entries.flatMap(({ ref }) => {
        const found = listed.find(({ nodeId }) => nodeId === ref.id);
        return found ? [found] : [];
      });
      return entries.length === drag.entries.length ? entries : ([] as TrashEntry[]);
    };
    const judge = (target: Parameters<EntriesRoute["verdict"]>[0]): EntriesVerdict | null => {
      const dragging = activeDragSession();
      if (dragging?.source === "trash") {
        const plan = planRestore(latest.current, trashed(dragging), target);
        if (plan.kind === "refuse") return { kind: "refuse", label: plan.label };
        return plan.kind === "ready" ? { kind: "accept", label: restoreLabel(plan) } : null;
      }
      const drop = resolve(target);
      const resolved = drop?.resolved;
      if (!drop || !resolved) return null;
      if (resolved.unavailable.length > 0) return { kind: "refuse", label: noLongerThere() };
      if (resolved.insideItself) return { kind: "refuse", label: insideItself() };
      if (resolved.asks) {
        const first = dropChoices(resolved, target).items.find((item) => item.enabled);
        if (!first) return null;
        return { kind: "accept", label: askLabel(first.label) };
      }
      const planned = planMove(resolved);
      if (planned.kind !== "ready") return null;
      return { kind: "accept", label: moveLabel(planned) };
    };
    let last: { key: string; inputs: readonly unknown[]; verdict: EntriesVerdict | null } | null =
      null;
    return {
      verdict(target) {
        const { areas } = latest.current;
        const key = treeDropTargetKey(target);
        const inputs = [activeDragSession(), areas];
        if (last?.key === key && last.inputs.every((input, index) => input === inputs[index]))
          return last.verdict;
        const verdict = judge(target);
        last = { key, inputs, verdict };
        return verdict;
      },
      drop(target, point) {
        const dragging = activeDragSession();
        if (dragging?.source === "trash") {
          const plan = planRestore(latest.current, trashed(dragging), target);
          if (plan.kind !== "ready") return;
          const restored = plan.entries.map((entry) => ({
            ref: trashRef(entry),
            name: entry.name,
          }));
          restoreInto(restored, plan.destination);
          revealPlaced(
            plan.destination.parentId,
            restored.map(({ ref }) => ref),
            latest.current.selection,
          );
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
  }, [projectId, restoreInto, runListMove]);

  const choice = useMemo<DropChoiceState | null>(() => {
    if (!pending) return null;
    const choicesNow = (view: PlacementView) =>
      dropChoices(resolveDrop(view, pending.drag, pending.target), pending.target);
    return {
      point: pending.point,
      returnFocus: pending.returnFocus,
      items: choicesNow({ areas }).items,
      choose(action: DropAction) {
        // Judged again from the trees now: the destination may have been renamed or removed.
        const { plans } = choicesNow(latest.current);
        if (action === "move" && plans.move) runListMove(plans.move);
        else if (action === "copy" && plans.copy) runListCopy(plans.copy);
      },
      dismiss: () => setPending(null),
    };
  }, [pending, areas, runListMove, runListCopy]);

  return useMemo(() => ({ selection, route, choice }), [selection, route, choice]);
}

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
