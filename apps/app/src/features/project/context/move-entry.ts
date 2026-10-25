/**
 * Resolves an area or folder choice to the replica's authoritative parent.
 * Placement and arrival naming live together in `entry-drag/execute-move.ts`;
 * refusal is judged by identity in `entry-drag/move-plan.ts`.
 */
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ParentRef } from "@meridian/resource-replica";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import type { TabOwner } from "@/client/stores";
import { destinationOwner } from "./identity-location";

/** An area's top level (its catalog root) or a folder in it. */
export type MoveDestination = {
  scheme: ProjectContextTreeScheme;
  owner: ContextOwner;
  catalog: CatalogContextView;
  entryId: string;
};

type WorkDirectory = Parameters<typeof destinationOwner>[1];
type NoWork = Parameters<typeof destinationOwner>[2];

/** The replica's parent for a destination: a folder by ID, or an area's root with its owning authority. */
export function destinationParent(
  destination: MoveDestination,
  works: WorkDirectory,
  noWork: NoWork,
): ParentRef | null {
  const { scheme, owner, catalog, entryId } = destination;
  if (entryId !== catalog.root.entryId) return { kind: "folder", folderId: entryId };
  const parsed = parseContextUri(catalog.root.uri);
  const tabOwner: TabOwner =
    owner.rootThreadId && parsed.ok && parsed.value.authority.kind === "lineage"
      ? { rootThreadId: owner.rootThreadId, rootThreadRef: parsed.value.authority.rootThreadRef }
      : { workId: owner.workId ?? undefined };
  const authority = destinationOwner({ scheme, ...tabOwner }, works, noWork);
  return authority ? { kind: "root", scheme, owner: authority } : null;
}
