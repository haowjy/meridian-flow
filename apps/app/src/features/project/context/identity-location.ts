/** Writer-facing location of an open tab, shared by the identity bar's surfaces. */

import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { type OpenDocument, type OpenDocumentOwner, replaceOwner } from "@/client/stores";
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
  /** Server path (leading slash), or null for a not-yet-materialized tab. */
  path: string | null;
} & OpenDocumentOwner;

export type IdentityDestination = {
  /** The folder (or source) the writer picked; absent when the folder path says it. */
  parentId?: string;
  scheme: ProjectContextTreeScheme;
  /** Tree-style parent folder path: `/`, `/Act 2`. */
  folderPath: string;
} & OpenDocumentOwner;

export type DesiredIdentity = {
  destination: IdentityDestination;
  name: string;
  /** Original input when optimistic collision allocation changes the displayed name. */
  typedName?: string;
};

/** Resolve a surface's folder choice into the complete final destination. */
export function identityDestination(
  location: TabLocation,
  editorWorkId: string | null,
  choice?: Pick<IdentityDestination, "scheme" | "folderPath" | "parentId">,
): IdentityDestination {
  const scheme = choice?.scheme ?? location.scheme;
  const folderPath = choice?.folderPath ?? location.parentPath;
  // A chat's Scratch stays in its lineage; nothing else becomes a lineage's.
  if (scheme === location.scheme && location.rootThreadId !== undefined)
    return {
      scheme,
      folderPath,
      ...(choice?.parentId ? { parentId: choice.parentId } : {}),
      ...replaceOwner(location),
    };
  const workId = isWorkScopedScheme(scheme)
    ? ((scheme === location.scheme ? location.workId : undefined) ?? editorWorkId ?? undefined)
    : undefined;
  return {
    scheme,
    folderPath,
    ...(choice?.parentId ? { parentId: choice.parentId } : {}),
    ...replaceOwner({ workId }),
  };
}

/** Where a tab's document sits; a tab with no path yet is in Unfiled. */
export function tabLocation(tab: OpenDocument): TabLocation {
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
    path: tab.path,
    ...replaceOwner(tab),
  };
}
