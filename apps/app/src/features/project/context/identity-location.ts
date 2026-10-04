/** Writer-facing location of an open tab, shared by the identity bar's surfaces. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { type ResourceWorkAuthority, resourceWorkAuthorityFor } from "@meridian/resource-replica";

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
  /** Server path (leading slash), or null for a not-yet-materialized tab. */
  path: string | null;
};

export type IdentityDestination = {
  scheme: ProjectContextTreeScheme;
  /** Tree-style parent folder path: `/`, `/Act 2`. */
  folderPath: string;
  workId?: string;
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
  const workId = isWorkScopedProjectContextScheme(scheme)
    ? ((scheme === location.scheme ? location.workId : undefined) ?? editorWorkId ?? undefined)
    : undefined;
  return {
    scheme,
    folderPath: choice?.folderPath ?? location.parentPath,
    ...(workId ? { workId } : {}),
  };
}

/** Resolve a placement's Work from the project snapshot; null while no known Work owns it. */
export function destinationWorkAuthority(
  destination: Pick<IdentityDestination, "scheme" | "workId">,
  works: readonly { id: string; slug: string | null }[] | null | undefined,
  noWork: { id: string } | null | undefined,
): ResourceWorkAuthority | null {
  if (destination.scheme !== "scratch" && !destination.workId) return { workId: null };
  const workId = destination.workId ?? noWork?.id;
  if (!workId) return null;
  try {
    return resourceWorkAuthorityFor(workId, works, noWork?.id);
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
    path: tab.path,
  };
}
