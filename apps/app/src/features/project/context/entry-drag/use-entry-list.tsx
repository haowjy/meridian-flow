/**
 * One list of rows is one selection, one route for rows dropped on it and one
 * drop scope. The Files tree is one list over the project's areas, User is
 * one, a chat's Scratch one over the current and Earlier notes, and a Work's
 * Files one over its Scratch.
 * Shells declare the catalogs they show; this owns the rest: what a hovered
 * target would do and what a drop does. A drop within one system moves at once;
 * one across systems waits for the writer's choice at the drop point (see
 * `drop-choice.ts`). It also offers optional selection and focus effects to
 * Move…; the project-owned notice does not depend on a list.
 */
import { t } from "@lingui/core/macro";
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  treeDropTargetKey,
} from "../tree-drop/tree-drop";
import { DropChoiceMenu, type DropChoiceState } from "./DropChoiceMenu";
import { activeEntryDrag } from "./drag-session";
import {
  type DropAction,
  dropChoices,
  moveLabel,
  type PendingChoice,
  type ReadyMove,
} from "./drop-choice";
import { entryKey } from "./entry";
import { type MoveResult, moveRows, renamesOnArrival } from "./execute-move";
import { describeRenames, MoveFeedbackProvider, useMoveNotices } from "./move-notice";
import { type MoveArea, type MoveView, planMove, resolveDrop } from "./move-plan";
import { type EntrySelection, EntrySelectionProvider, useEntrySelection } from "./selection";

type ListMoveEffects = {
  select: (result: MoveResult) => void;
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
  feedback: ListMoveEffects & { surface: NoticeSurface };
  /** The menu a drop across systems waits on; null while none does. */
  choice: DropChoiceState | null;
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

  const [pending, setPending] = useState<PendingChoice | null>(null);

  /** Moves the planned rows and reports on `to`'s surface, the way Move… does. */
  const runMove = useCallback(
    (move: ReadyMove, to: Pick<PendingChoice, "surface" | "returnFocus">) => {
      void moveRows(move.moves, { resources, projectId }).then((result) => {
        moveEffects.select(result);
        notices.publish(to.surface, result, move.destinationName, to.returnFocus);
      });
    },
    [resources, projectId, notices, moveEffects],
  );

  const route = useMemo<EntriesRoute>(() => {
    const plan = (target: Parameters<EntriesRoute["verdict"]>[0]) => {
      const entries = activeEntryDrag();
      if (!entries) return null;
      const view = moveView(latest.current);
      const resolved = resolveDrop(view, entries, target);
      return {
        entries,
        crossing: resolved?.crossing ?? false,
        planned: planMove(view, resolved),
      };
    };
    const judge = (target: Parameters<EntriesRoute["verdict"]>[0]): EntriesVerdict | null => {
      const drop = plan(target);
      if (drop?.planned.kind === "inside-itself")
        return { kind: "refuse", label: t`Can't go inside itself` };
      if (drop?.planned.kind !== "ready") return null;
      const { projection } = latest.current;
      const label = moveLabel(drop.planned);
      return {
        kind: "accept",
        // An ellipsis says a choice follows the drop.
        label: drop.crossing ? `${label}…` : label,
        warning: describeRenames(renamesOnArrival(drop.planned.moves, projection)),
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
        const drop = plan(target);
        if (drop?.planned.kind !== "ready") return;
        const to = { surface, returnFocus: moveEffects.refocus };
        // `dragend` clears the drag session after this, so the choice keeps the entries.
        if (drop.crossing) setPending({ entries: drop.entries, target, point, ...to });
        else runMove(drop.planned, to);
      },
    };
  }, [runMove, surface, moveEffects]);

  const choice = useMemo<DropChoiceState | null>(() => {
    if (!pending) return null;
    return {
      point: pending.point,
      returnFocus: pending.returnFocus,
      items: dropChoices(moveView({ areas, projection, works, noWork }), pending).items,
      choose(action: DropAction) {
        // Judged again from the replica now: the destination may have been renamed or removed.
        const move = dropChoices(moveView(latest.current), pending).plans[action];
        if (move) runMove(move, pending);
      },
      dismiss: () => setPending(null),
    };
  }, [pending, areas, projection, works, noWork, runMove]);

  const feedback = useMemo(() => ({ ...moveEffects, surface }), [moveEffects, surface]);
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
        <MoveFeedbackProvider feedback={list.feedback}>
          {children}
          {list.choice ? <DropChoiceMenu {...list.choice} /> : null}
        </MoveFeedbackProvider>
      </EntrySelectionProvider>
    </TreeDropScope>
  );
}
