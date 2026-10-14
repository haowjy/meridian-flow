/** Where an import lands: an area root or a folder inside Manuscript, Knowledge Base or Unfiled. */
import { t } from "@lingui/core/macro";
import { IMPORT_SCHEMES, type ImportScheme } from "@meridian/contracts";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

export function isImportScheme(scheme: ProjectContextTreeScheme): scheme is ImportScheme {
  return (IMPORT_SCHEMES as readonly string[]).includes(scheme);
}

export type ImportDestination = {
  scheme: ImportScheme;
  /** The folder's catalog path ("/Lore/Sects"); "/" at the area root. */
  path: string;
  /** The folder's canonical URI, as the manifest names it ("kb://Lore/Sects/"). */
  uri: string;
  /** The folder's name, or the area's name at the root. */
  name: string;
  /** The folder's catalog id; null at the area root. */
  folderId: string | null;
};

export function areaLabel(scheme: ImportScheme): string {
  return scheme === "manuscript"
    ? t`Manuscript`
    : scheme === "unfiled"
      ? t`Unfiled`
      : t`Knowledge Base`;
}

/** Where an import lands when started on, or dropped onto, a folder (null: the area's root). */
export function destinationOf(
  scheme: ProjectContextTreeScheme,
  folder: { entryId: string; path: string; uri: string; name: string } | null,
): ImportDestination | null {
  if (!isImportScheme(scheme)) return null;
  return folder
    ? { scheme, path: folder.path, uri: folder.uri, name: folder.name, folderId: folder.entryId }
    : { scheme, path: "/", uri: `${scheme}://`, name: areaLabel(scheme), folderId: null };
}
