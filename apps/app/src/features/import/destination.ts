import { IMPORT_SCHEMES, type ImportScheme } from "@meridian/contracts";
import { contextRootUri } from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { schemeLabel } from "@/features/project/context/context-schemes";

export function isImportScheme(scheme: ProjectContextTreeScheme): scheme is ImportScheme {
  return (IMPORT_SCHEMES as readonly string[]).includes(scheme);
}

export type ImportDestination = {
  scheme: ImportScheme;
  path: string;
  uri: string;
  name: string;
  folderId: string | null;
};

export function destinationOf(
  scheme: ProjectContextTreeScheme,
  folder: { entryId: string; path: string; uri: string; name: string } | null,
): ImportDestination | null {
  if (!isImportScheme(scheme)) return null;
  return folder
    ? { scheme, path: folder.path, uri: folder.uri, name: folder.name, folderId: folder.entryId }
    : { scheme, path: "/", uri: contextRootUri(scheme), name: schemeLabel(scheme), folderId: null };
}
