/**
 * The one way a row changes folders: Move…, dragging and a drag's Undo resolve
 * a destination here and place through the replica by folder ID. A taken name
 * never refuses: the row arrives at the next free name, predicted by
 * `execute-move.ts` (shown before the drop) and decided by the server. Refusals
 * are judged by identity in `entry-drag/move-plan.ts`.
 */
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ParentRef, ResourceDestination } from "@meridian/resource-replica";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import type { TabOwner } from "@/client/stores";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import { destinationOwner } from "./identity-location";

/** An area's top level (its catalog root) or a folder in it. */
export type MoveDestination = {
  scheme: ProjectContextTreeScheme;
  owner: ContextOwner;
  catalog: CatalogContextView;
  entryId: string;
  /** The folder's path, or "/" for the area root. */
  path: string;
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

/**
 * Places one entry under `name`, the free name its caller predicted (see
 * `execute-move.ts`); `typed` is the name the writer asked for. Resolves to the
 * operation ID its link-update note follows.
 */
export async function placeEntry(
  resources: AccountResourceReplica,
  projectId: string,
  subject: { kind: "file" | "folder"; id: string },
  location: ResourceDestination,
  typed: string,
): Promise<string | null> {
  if (subject.kind === "folder") {
    const result = await resources.setFolderLocation(projectId, subject.id, location, typed);
    return result.operationId ?? null;
  }
  const key = await resources.keyForDocument(projectId, subject.id);
  if (!key) throw new Error("Document is not in the replica");
  const result = await resources.setLocation(projectId, key, location, typed);
  return result.operationId ?? null;
}
