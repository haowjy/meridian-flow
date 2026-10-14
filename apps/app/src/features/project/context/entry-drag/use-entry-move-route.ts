/**
 * The drop route for rows dragged within one system: decides what a target
 * would do (move, refuse with a reason, or nothing), moves on drop through the
 * shared move path, reselects what moved and offers Undo.
 */
import { plural, t } from "@lingui/core/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useWorks } from "@/client/query/useWorks";
import { useAccountResourceReplica } from "../account-feature-context";
import { schemeLabel } from "../context-schemes";
import {
  type MoveDestination,
  type MoveRefusal,
  moveRefusal,
  placeEntry,
  resourceDestination,
} from "../move-entry";
import type { TreeDropRoutes, TreeDropTarget } from "../tree-drop/tree-drop";
import { activeEntryDrag } from "./drag-session";
import { entrySystem, type SelectableEntry } from "./entry";
import { showMoveNotice } from "./move-notice";
import { useOptionalEntrySelectionScope } from "./selection";

type Plan = {
  destination: MoveDestination;
  destinationName: string;
  moving: SelectableEntry[];
  refusal: { refusal: MoveRefusal; entry: SelectableEntry } | null;
};

export function useEntryMoveRoute({
  projectId,
  scheme,
  owner,
  catalog,
  onLanded,
}: {
  projectId: string;
  scheme: ProjectContextTreeScheme;
  owner: ContextOwner;
  catalog: CatalogContextView | null;
  /** Opens the destination folder so the moved rows are in view. */
  onLanded?: (target: TreeDropTarget) => void;
}): NonNullable<TreeDropRoutes["entries"]> {
  const resources = useAccountResourceReplica();
  const { works, noWork } = useWorks(projectId);
  const selection = useOptionalEntrySelectionScope();

  return useMemo(() => {
    const plan = (target: TreeDropTarget): Plan | null => {
      const drag = activeEntryDrag();
      if (!drag || !catalog || target.scheme !== scheme) return null;
      if (drag.system !== entrySystem(scheme, owner)) return null;
      const destination: MoveDestination = {
        scheme,
        owner,
        catalog,
        entryId: target.folder?.entryId ?? catalog.root.entryId,
        path: target.folder?.path ?? "/",
      };
      const moving: SelectableEntry[] = [];
      let refusal: Plan["refusal"] = null;
      for (const entry of drag.entries) {
        const refused = moveRefusal(entry, destination);
        if (!refused) moving.push(entry);
        else if (refused.kind !== "already-there") refusal ??= { refusal: refused, entry };
      }
      return {
        destination,
        destinationName: target.folder?.name ?? schemeLabel(scheme),
        moving,
        refusal,
      };
    };

    const place = (
      entries: readonly SelectableEntry[],
      to: (entry: SelectableEntry) => MoveDestination,
    ) =>
      Promise.allSettled(
        entries.map(async (entry) => {
          const location = resourceDestination(to(entry), entry.name, works, noWork);
          if (!location) throw new Error("Destination is unavailable");
          await placeEntry(resources, projectId, entry, location);
        }),
      ).then((results) => entries.filter((_, index) => results[index]?.status === "rejected"));

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
        selection?.replace(
          moving.map((entry) => `${scheme}:${entry.key.slice(entry.key.indexOf(":") + 1)}`),
        );
        onLanded?.(target);
        void place(moving, () => destination).then((failed) => {
          const [first] = moving;
          if (!first) return;
          if (failed.length > 0) {
            const [lost] = failed;
            showMoveNotice(
              failed.length === 1 && lost
                ? t`Couldn't move ${lost.name} to ${destinationName}.`
                : plural(failed.length, {
                    one: `Couldn't move # item to ${destinationName}.`,
                    other: `Couldn't move # items to ${destinationName}.`,
                  }),
              null,
            );
            return;
          }
          const message =
            moving.length === 1
              ? t`Moved ${first.name} to ${destinationName}.`
              : plural(moving.length, {
                  one: `Moved # item to ${destinationName}.`,
                  other: `Moved # items to ${destinationName}.`,
                });
          showMoveNotice(message, async () => {
            const stuck = await place(moving, (entry) => ({
              scheme: entry.scheme,
              owner: entry.owner,
              catalog: entry.catalog,
              entryId: entry.parentId ?? entry.catalog.root.entryId,
              path: entry.parentPath,
            }));
            selection?.replace(moving.map((entry) => entry.key));
            const [lost] = stuck;
            if (stuck.length === 1 && lost) throw new Error(t`Couldn't move ${lost.name} back.`);
            if (stuck.length > 1)
              throw new Error(
                plural(stuck.length, {
                  one: "Couldn't move # item back.",
                  other: "Couldn't move # items back.",
                }),
              );
          });
        });
      },
    };
  }, [catalog, scheme, owner, works, noWork, resources, projectId, selection, onLanded]);
}
