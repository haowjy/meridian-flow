/** Where an import lands: an area root or a folder inside Manuscript, Knowledge Base or Unfiled. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

export const IMPORT_SCHEMES = ["manuscript", "kb", "unfiled"] as const;
export type ImportScheme = (typeof IMPORT_SCHEMES)[number];

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

export function joinCatalogPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

export function parentCatalogPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}
