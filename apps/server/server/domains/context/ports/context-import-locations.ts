/** Import-only parent identity lookup under the current namespace lock. */
export interface ContextImportParent {
  sourceId: string;
  folderId: string | null;
  uri: string;
  children: { kind: "folder" | "file"; name: string; extension: string }[];
}
export class ContextImportParentMovedError extends Error {}
export interface ContextImportLocations {
  destination(uri: string): Promise<{ sourceId: string; folderId: string | null }>;
  lockParent(sourceId: string, folderId: string | null): Promise<ContextImportParent | null>;
  lockDocument(id: string): Promise<boolean>;
  currentUri(id: string, kind: "folder" | "file"): Promise<string | null>;
}
