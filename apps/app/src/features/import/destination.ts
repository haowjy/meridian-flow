/** Where an import lands: an area root or a folder inside Manuscript, Knowledge or Unfiled. */

import { IMPORT_SCHEMES, type ImportScheme } from "@meridian/contracts";
import { contextRootUri } from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { schemeLabel } from "@/features/project/context/context-schemes";

export function isImportScheme(scheme: ProjectContextTreeScheme): scheme is ImportScheme {
  return (IMPORT_SCHEMES as readonly string[]).includes(scheme);
}

export type ImportDestination = {
  scheme: ImportScheme;
  /** The folder's path ("/Lore/Sects"); "/" at the area root. */
  path: string;
  /** The folder's canonical URI, as the manifest names it ("kb://Lore/Sects", no trailing slash). */
  uri: string;
  /** The folder's name, or the area's name at the root. */
  name: string;
  /** The folder's node id; null at the area root. */
  folderId: string | null;
};

/** Where an import lands when started on, or dropped onto, a folder (null: the area's root). */
export function destinationOf(
  scheme: ProjectContextTreeScheme,
  folder: { entryId: string; path: string; uri: string; name: string } | null,
): ImportDestination | null {
  if (!isImportScheme(scheme)) return null;
  return folder
    ? { scheme, path: folder.path, uri: folder.uri, name: folder.name, folderId: folder.entryId }
    : { scheme, path: "/", uri: contextRootUri(scheme), name: schemeLabel(scheme), folderId: null };
}
