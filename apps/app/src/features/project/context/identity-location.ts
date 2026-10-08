/** Writer-facing location of an open tab, shared by the identity bar's surfaces. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { type ResourceOwner, resourceWorkAuthorityFor } from "@meridian/resource-replica";

import type { ContextTab } from "@/client/stores";
import { parentPath as parentFolderPath } from "./file-suggestions";

export type TabLocation = {
  scheme: ProjectContextTreeScheme;
  /** Tree-style parent folder path: `/` for a scheme root. */
  parentPath: string;
  folders: string[];
  leaf: string;
  provisional: boolean;
  /** Whether the identity bar's typed surfaces may edit this tab. */
  editable: boolean;
  workId?: string;
  /** A chat's Scratch: its lineage's first chat id and the handle its URI spells. */
  rootThreadId?: string;
  rootThreadRef?: string;
  /** Server path (leading slash), or null for a not-yet-materialized tab. */
  path: string | null;
};

export type IdentityDestination = {
  scheme: ProjectContextTreeScheme;
  /** Tree-style parent folder path: `/`, `/Act 2`. */
  folderPath: string;
  workId?: string;
  rootThreadId?: string;
  rootThreadRef?: string;
};

export type DesiredIdentity = {
  destination: IdentityDestination;
  name: string;
};

/** Resolve a surface's folder choice into the complete final destination. */
export function identityDestination(
  location: TabLocation,
  editorWorkId: string | null,
  choice?: Pick<IdentityDestination, "scheme" | "folderPath">,
): IdentityDestination {
  const scheme = choice?.scheme ?? location.scheme;
  // A chat's Scratch stays in its lineage; nothing else becomes a lineage's.
  if (scheme === location.scheme && location.rootThreadId && location.rootThreadRef)
    return {
      scheme,
      folderPath: choice?.folderPath ?? location.parentPath,
      rootThreadId: location.rootThreadId,
      rootThreadRef: location.rootThreadRef,
    };
  const workId = isWorkScopedProjectContextScheme(scheme)
    ? ((scheme === location.scheme ? location.workId : undefined) ?? editorWorkId ?? undefined)
    : undefined;
  return {
    scheme,
    folderPath: choice?.folderPath ?? location.parentPath,
    ...(workId ? { workId } : {}),
  };
}

/**
 * Resolve a placement's owner: a chat's lineage as stated, otherwise the Work
 * from the project snapshot; null while no known Work owns it.
 */
export function destinationOwner(
  destination: Pick<IdentityDestination, "scheme" | "workId" | "rootThreadId" | "rootThreadRef">,
  works: readonly { id: string; slug: string | null }[] | null | undefined,
  noWork: { id: string } | null | undefined,
): ResourceOwner | null {
  if (destination.rootThreadId && destination.rootThreadRef)
    return {
      workId: null,
      rootThreadId: destination.rootThreadId,
      rootThreadRef: destination.rootThreadRef,
    };
  if (destination.scheme !== "scratch" && !destination.workId) return { workId: null };
  const workId = destination.workId;
  if (!workId || !noWork) return null;
  try {
    return resourceWorkAuthorityFor(workId, { works: works ?? [], noWork });
  } catch {
    return null;
  }
}

/** Local documents acquire their first durable location in the project Unfiled source. */
export function tabLocation(tab: ContextTab): TabLocation {
  if (tab.kind === "new") {
    return {
      scheme: "unfiled",
      parentPath: "/",
      folders: [],
      leaf: tab.name,
      provisional: true,
      editable: true,
      path: null,
    };
  }
  const segments = tab.path.split("/").filter(Boolean);
  return {
    scheme: tab.scheme,
    parentPath: parentFolderPath(tab.path),
    folders: segments.slice(0, -1),
    leaf: tab.name,
    provisional:
      tab.scheme === "unfiled" || (tab.kind === "tracked" && Boolean(tab.provisionalName)),
    editable: tab.kind === "tracked",
    workId: tab.workId,
    rootThreadId: tab.rootThreadId,
    rootThreadRef: tab.rootThreadRef,
    path: tab.path,
  };
}
