/**
 * The one way a row changes folders: Move… and dragging both resolve a
 * destination here, refuse for the same reasons, and place through the replica
 * by folder ID.
 */
import { t } from "@lingui/core/macro";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ResourceDestination } from "@meridian/resource-replica";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import type { TabOwner } from "@/client/stores";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import { validateContextEntryName } from "./context-entry-name";
import { destinationOwner } from "./identity-location";
import { isFolderWithin } from "./menu-tree";

export type MoveSubject = {
  kind: "file" | "folder";
  /** The document ID for a file, the folder's entry ID for a folder. */
  id: string;
  name: string;
  path: string;
  /** The catalog the subject lives in; a folder cannot go inside itself there. */
  catalog: CatalogContextView | null;
  /** The folder it sits in now (the catalog root at an area's top level). */
  parentId: string | null;
};

/** An area's top level (its catalog root) or a folder in it. */
export type MoveDestination = {
  scheme: ProjectContextTreeScheme;
  owner: ContextOwner;
  catalog: CatalogContextView;
  entryId: string;
  /** The folder's path, or "/" for the area root. */
  path: string;
};

export type MoveRefusal =
  | { kind: "inside-itself" }
  | { kind: "already-there" }
  | { kind: "name-taken"; message: string };

type WorkDirectory = Parameters<typeof destinationOwner>[1];
type NoWork = Parameters<typeof destinationOwner>[2];

export function moveRefusal(
  subject: MoveSubject,
  destination: MoveDestination,
  name: string = subject.name,
): MoveRefusal | null {
  if (
    subject.kind === "folder" &&
    subject.catalog === destination.catalog &&
    isFolderWithin(destination.path, subject.path)
  )
    return { kind: "inside-itself" };
  if (subject.catalog === destination.catalog && subject.parentId === destination.entryId)
    return { kind: "already-there" };
  const collision = validateContextEntryName(
    name,
    destination.catalog.children(destination.entryId),
    subject.kind,
    subject.name,
  );
  return collision?.level === "error" ? { kind: "name-taken", message: collision.message } : null;
}

/** What a refused drop or pick says, or null when it should stay quiet. */
export function moveRefusalLabel(refusal: MoveRefusal): string | null {
  if (refusal.kind === "inside-itself") return t`Can't go inside itself`;
  if (refusal.kind === "name-taken") return refusal.message;
  return null;
}

/** The replica's destination: a folder by ID, or an area's root with its owning authority. */
export function resourceDestination(
  destination: MoveDestination,
  name: string,
  works: WorkDirectory,
  noWork: NoWork,
): ResourceDestination | null {
  if (destination.entryId !== destination.catalog.root.entryId)
    return { parent: { kind: "folder", folderId: destination.entryId }, name };
  const parsed = parseContextUri(destination.catalog.root.uri);
  const owner: TabOwner =
    destination.owner.rootThreadId && parsed.ok && parsed.value.authority.kind === "lineage"
      ? {
          rootThreadId: destination.owner.rootThreadId,
          rootThreadRef: parsed.value.authority.rootThreadRef,
        }
      : { workId: destination.owner.workId ?? undefined };
  const authority = destinationOwner({ scheme: destination.scheme, ...owner }, works, noWork);
  if (!authority) return null;
  return { parent: { kind: "root", scheme: destination.scheme, owner: authority }, name };
}

/** Places one entry; resolves to the operation ID that its link-update note follows. */
export async function placeEntry(
  resources: AccountResourceReplica,
  projectId: string,
  subject: Pick<MoveSubject, "kind" | "id">,
  location: ResourceDestination,
): Promise<string | null> {
  if (subject.kind === "folder") {
    return (await resources.setFolderLocation(projectId, subject.id, location)).operationId ?? null;
  }
  const key = await resources.keyForDocument(projectId, subject.id);
  if (!key) throw new Error("Document is not in the replica");
  return (await resources.setLocation(projectId, key, location)).operationId ?? null;
}
