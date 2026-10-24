/**
 * One list of rows is one selection, one route for rows dropped on it and one
 * drop scope. The Files tree is one list over its four areas, a chat's Scratch
 * one over the current and Earlier notes, a Work's Files one over its Scratch.
 * Shells declare the catalogs they show; this owns the rest: what a hovered
 * target would do, what a drop does, and what any move from the list (a drop
 * or Move…) leaves behind: the moved rows selected and a notice with Undo.
 */
import { t } from "@lingui/core/macro";
import type { ParentRef } from "@meridian/resource-replica";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { useWorks } from "@/client/query/useWorks";
import {
  useAccountResourceProjection,
  useAccountResourceReplica,
} from "../account-feature-context";
import type { ContextEntrySibling } from "../context-entry-name";
import { menuEntryFor } from "../menu-tree";
import { destinationParent } from "../move-entry";
import { type EntriesRoute, TreeDropScope } from "../tree-drop/tree-drop";
import { activeEntryDrag } from "./drag-session";
import { type DragEntry, entryKey } from "./entry";
import { executeMove, type MoveContext, type MoveResult, undoMove } from "./execute-move";
import { describeMove, describeUndoFailure, useMoveNoticePublisher } from "./move-notice";
import { type MoveArea, planMove, sameParent, withoutNested } from "./move-plan";
import { type EntrySelection, EntrySelectionProvider, useEntrySelection } from "./selection";

/** Reports a finished move: selects what moved and leaves the notice. */
type ReportMove = (result: MoveResult, destinationName: string) => void;

type EntryListController = {
  selection: EntrySelection;
  route: EntriesRoute;
  moved: ReportMove;
};

const MovedContext = createContext<ReportMove | null>(null);

/** The list a row sits in, for Move… to report like a drop; null outside a list (the phone). */
export function useReportMove(): ReportMove | null {
  return useContext(MovedContext);
}

export function useEntryList({
  projectId,
  areas,
}: {
  projectId: string;
  /** Every catalog this list shows; a target names its catalog by root ID. */
  areas: readonly MoveArea[];
}): EntryListController {
  const resources = useAccountResourceReplica();
  const { works, noWork } = useWorks(projectId);
  const projection = useAccountResourceProjection(projectId);
  const publish = useMoveNoticePublisher();
  // Hovers plan from the latest observation without remaking the route (and re-rendering every target).
  const prune = useCallback(
    (entries: DragEntry[]) => withoutNested(latest.current.projection, entries),
    [],
  );
  const selection = useEntrySelection(prune);
  const latest = useRef({ areas, projection, works, noWork, publish, selection });
  useLayoutEffect(() => {
    latest.current = { areas, projection, works, noWork, publish, selection };
  });

  const moved = useCallback<ReportMove>(
    (result, destinationName) => {
      const { publish, selection } = latest.current;
      if (result.moved.length > 0)
        selection.replace(result.moved.map((effect) => entryKey(effect.entry)));
      const context: MoveContext = {
        resources,
        projectId,
        siblingsAt: (parent) => siblingsAt(latest.current.areas, parent),
      };
      publish?.(
        describeMove(result, destinationName),
        result.moved.length > 0
          ? () => undoMove(result.moved, context).then(describeUndoFailure)
          : null,
      );
    },
    [resources, projectId],
  );

  const route = useMemo<EntriesRoute>(() => {
    const plan = (target: Parameters<EntriesRoute["verdict"]>[0]) => {
      const entries = activeEntryDrag();
      const { areas, projection } = latest.current;
      return entries ? planMove({ ...projection, areas }, entries, target) : null;
    };
    return {
      verdict(target) {
        const planned = plan(target);
        if (planned?.kind === "inside-itself")
          return { kind: "refuse", label: t`Can't go inside itself` };
        if (planned?.kind !== "ready") return null;
        const { destinationName } = planned;
        return { kind: "accept", label: t`Move to ${destinationName}` };
      },
      drop(target) {
        const planned = plan(target);
        if (planned?.kind !== "ready") return;
        const { works, noWork } = latest.current;
        const after = destinationParent(planned.destination, works, noWork);
        void executeMove(planned, after, {
          resources,
          projectId,
          siblingsAt: (parent) => siblingsAt(latest.current.areas, parent),
        }).then((result) => moved(result, planned.destinationName));
      },
    };
  }, [resources, projectId, moved]);

  return useMemo(() => ({ selection, route, moved }), [selection, route, moved]);
}

/** What `parent` holds in the catalogs the list shows; empty when it shows none of them. */
function siblingsAt(areas: readonly MoveArea[], parent: ParentRef): readonly ContextEntrySibling[] {
  for (const { catalog, scheme, owner } of areas) {
    if (parent.kind === "folder") {
      if (menuEntryFor(catalog, parent.folderId)?.kind === "dir")
        return catalog.children(parent.folderId);
    } else if (sameParent(parent, { kind: "root", scheme, owner }))
      return catalog.children(catalog.root.entryId);
  }
  return [];
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
