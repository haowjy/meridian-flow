/**
 * One list of rows is one selection, one route for rows dropped on it and one
 * drop scope. The Files tree is one list over its four areas, a chat's Scratch
 * one over the current and Earlier notes, a Work's Files one over its Scratch.
 * Shells declare the catalogs they show; this owns the rest: what a hovered
 * target would do, what a drop does, and the notice it leaves.
 */
import { t } from "@lingui/core/macro";
import type { ParentRef } from "@meridian/resource-replica";
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef } from "react";
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
import { executeMove, type MoveContext, undoMove } from "./execute-move";
import { describeMove, describeUndoFailure, useMoveNoticePublisher } from "./move-notice";
import { type MoveArea, planMove, sameParent, withoutNested } from "./move-plan";
import { type EntrySelection, EntrySelectionProvider, useEntrySelection } from "./selection";

export type EntryListController = { selection: EntrySelection; route: EntriesRoute };

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
        const { works, noWork, publish, selection } = latest.current;
        selection.replace(planned.moves.map((move) => entryKey(move.ref)));
        const after = destinationParent(planned.destination, works, noWork);
        const context: MoveContext = {
          resources,
          projectId,
          siblingsAt: (parent) => siblingsAt(latest.current.areas, parent),
        };
        void executeMove(planned, after, context).then((result) =>
          publish?.(
            describeMove(result, planned),
            result.moved.length > 0
              ? () => undoMove(result.moved, context).then(describeUndoFailure)
              : null,
          ),
        );
      },
    };
  }, [resources, projectId]);

  return useMemo(() => ({ selection, route }), [selection, route]);
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
      <EntrySelectionProvider selection={list.selection}>{children}</EntrySelectionProvider>
    </TreeDropScope>
  );
}
