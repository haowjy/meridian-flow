/**
 * The drop route for rows dragged within one system: decides what a target
 * would do (move, refuse with a reason, or nothing), moves on drop through the
 * shared move path, reselects what moved and offers Undo.
 *
 * Placement is optimistic: a move resolves once the replica admits it, and a
 * later server refusal lands on the row as its failure mark with Move… to
 * repair, exactly as for Move…. Each placement is remembered so the row's
 * link-update note follows its receipt.
 */
import { plural, t } from "@lingui/core/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { CatalogContextView, CatalogNode } from "@/client/query/context-catalog-projection";
import { useWorks } from "@/client/query/useWorks";
import { useAccountResourceReplica } from "../account-feature-context";
import type { ContextEntrySibling } from "../context-entry-name";
import { schemeLabel } from "../context-schemes";
import { menuEntryFor } from "../menu-tree";
import {
  type MoveDestination,
  type MoveRefusal,
  moveRefusal,
  type PlacementParent,
  placeEntry,
  placementParent,
  resourceDestination,
} from "../move-entry";
import { renameOperationLifecycle } from "../rename-operation-lifecycle";
import type { TreeDropRoutes, TreeDropTarget } from "../tree-drop/tree-drop";
import { activeEntryDrag } from "./drag-session";
import { entrySystem, type SelectableEntry } from "./entry";
import { type MoveNoticeSurface, showMoveNotice } from "./move-notice";
import type { EntrySelection } from "./selection";

export type MoveArea = {
  scheme: ProjectContextTreeScheme;
  owner: ContextOwner;
  catalog: CatalogContextView;
  /** The owner accepts moves (an archived Work's Scratch does not). */
  movable: boolean;
};

type Plan = {
  destination: MoveDestination;
  destinationName: string;
  moving: SelectableEntry[];
  refusal: { refusal: MoveRefusal; entry: SelectableEntry } | null;
};

export function useEntryMoveRoute({
  projectId,
  areas,
  selection,
  surface,
  onLanded,
}: {
  projectId: string;
  /** Where the list sits; the drop's notice shows there. */
  surface: MoveNoticeSurface;
  /** The catalogs this list shows; a target names its catalog by root ID. */
  areas: readonly MoveArea[];
  /** The list's own selection: what moved is reselected there. */
  selection: EntrySelection;
  /** Opens the destination folder so the moved rows are in view. */
  onLanded?: (target: TreeDropTarget) => void;
}): NonNullable<TreeDropRoutes["entries"]> {
  const resources = useAccountResourceReplica();
  const { works, noWork } = useWorks(projectId);
  // Undo runs seconds after the drop; it must read the catalogs as they are then.
  const latestAreas = useRef(areas);
  useLayoutEffect(() => {
    latestAreas.current = areas;
  });

  return useMemo(() => {
    const plan = (target: TreeDropTarget): Plan | null => {
      const drag = activeEntryDrag();
      const area = areas.find(
        (candidate) => candidate.catalog.root.entryId === target.catalogRootId,
      );
      if (!drag?.system || !area?.movable || target.scheme !== area.scheme) return null;
      const { scheme, owner, catalog } = area;
      if (drag.system !== entrySystem(scheme, owner)) return null;
      const folder = target.folder ? menuEntryFor(catalog, target.folder.entryId) : null;
      if (target.folder && (folder?.kind !== "dir" || folder.navigationOnly)) return null;
      const destination: MoveDestination = {
        scheme,
        owner,
        catalog,
        entryId: target.folder?.entryId ?? catalog.root.entryId,
        path: target.folder?.path ?? "/",
      };
      const moving: SelectableEntry[] = [];
      const incoming: ContextEntrySibling[] = [];
      let refusal: Plan["refusal"] = null;
      for (const entry of drag.entries) {
        const refused = moveRefusal(entry, destination, entry.name, incoming);
        if (!refused) {
          moving.push(entry);
          incoming.push({
            entryId: entry.id,
            name: entry.name,
            kind: entry.kind === "file" ? "file" : "dir",
          });
        } else if (refused.kind !== "already-there") refusal ??= { refusal: refused, entry };
      }
      return {
        destination,
        destinationName: target.folder?.name ?? schemeLabel(scheme),
        moving,
        refusal,
      };
    };

    const lifecycle = renameOperationLifecycle(resources);
    /** Places each entry under `parent`; resolves to the entries the replica would not admit. */
    const place = async (
      entries: readonly { entry: SelectableEntry; name: string; parent: PlacementParent }[],
    ) => {
      const results = await Promise.allSettled(
        entries.map(async ({ entry, name, parent }) => {
          const location = resourceDestination(parent, name, works, noWork);
          if (!location) throw new Error("Destination is unavailable");
          const operationId = await placeEntry(resources, projectId, entry, location);
          if (operationId) lifecycle.remember(projectId, entry, operationId);
        }),
      );
      return entries
        .filter((_, index) => results[index]?.status === "rejected")
        .map(({ entry }) => entry);
    };

    /** The node as the list shows it now (name and folder may have changed since the drop). */
    const currentNode = (entry: SelectableEntry): CatalogNode | null => {
      for (const { catalog } of latestAreas.current) {
        const node =
          entry.kind === "file" ? catalog.findDocument(entry.id) : menuEntryFor(catalog, entry.id);
        if (node) return node;
      }
      return null;
    };

    const undo = (moved: readonly SelectableEntry[], destination: MoveDestination) => async () => {
      // A row that moved again since is the writer's newer choice; leave it.
      const returning = moved.flatMap((entry) => {
        const node = currentNode(entry);
        if (node && node.parentId !== destination.entryId) return [];
        return [{ entry, name: node?.name ?? entry.name, parent: entry.origin }];
      });
      const stuck = await place(returning);
      selection.replace(
        returning.filter(({ entry }) => !stuck.includes(entry)).map(({ entry }) => entry.key),
      );
      const [lost] = stuck;
      if (stuck.length === 1 && lost) throw new Error(t`Couldn't move ${lost.name} back.`);
      if (stuck.length > 1)
        throw new Error(
          plural(stuck.length, {
            one: "Couldn't move # item back.",
            other: "Couldn't move # items back.",
          }),
        );
    };

    return {
      verdict(target) {
        const planned = plan(target);
        if (!planned) return null;
        const { refusal, moving, destinationName } = planned;
        if (refusal) {
          return {
            kind: "refuse",
            label:
              refusal.refusal.kind === "inside-itself"
                ? t`Can't go inside itself`
                : t`${destinationName} already has ${refusal.entry.name}`,
          };
        }
        if (moving.length === 0) return null;
        return { kind: "accept", label: t`Move to ${destinationName}` };
      },
      drop(target) {
        const planned = plan(target);
        if (!planned || planned.refusal || planned.moving.length === 0) return;
        const { destination, destinationName, moving } = planned;
        const parent = placementParent(destination);
        selection.replace(
          moving.map(
            (entry) => `${destination.scheme}:${entry.key.slice(entry.key.indexOf(":") + 1)}`,
          ),
        );
        onLanded?.(target);
        void place(moving.map((entry) => ({ entry, name: entry.name, parent }))).then((failed) => {
          const moved = moving.filter((entry) => !failed.includes(entry));
          const parts: string[] = [];
          const [first] = moved;
          if (moved.length === 1 && first)
            parts.push(t`Moved ${first.name} to ${destinationName}.`);
          else if (moved.length > 1)
            parts.push(
              plural(moved.length, {
                one: `Moved # item to ${destinationName}.`,
                other: `Moved # items to ${destinationName}.`,
              }),
            );
          const [lost] = failed;
          if (failed.length === 1 && lost) parts.push(t`Couldn't move ${lost.name}.`);
          else if (failed.length > 1)
            parts.push(
              plural(failed.length, {
                one: "Couldn't move # item.",
                other: "Couldn't move # items.",
              }),
            );
          showMoveNotice(
            surface,
            parts.join(" "),
            moved.length > 0 ? undo(moved, destination) : null,
          );
        });
      },
    };
  }, [areas, works, noWork, resources, projectId, selection, surface, onLanded]);
}
