/** Import-only parent identity lookup under the current namespace lock. */
export interface ContextImportParent {
  sourceId: string;
  folderId: string | null;
  uri: string;
  children: { kind: "folder" | "file"; name: string; extension: string }[];
}
export class ContextImportParentMovedError extends Error {}
/** The destination URI is not a project area folder, or names one that does not exist. */
export class ContextImportDestinationError extends Error {
  constructor(readonly code: "destination_invalid" | "destination_not_found") {
    super(code);
  }
}
export interface ContextImportLocations {
  destination(uri: string): Promise<{ sourceId: string; folderId: string | null }>;
  lockParent(sourceId: string, folderId: string | null): Promise<ContextImportParent | null>;
  lockDocument(id: string): Promise<boolean>;
  currentUri(id: string, kind: "folder" | "file"): Promise<string | null>;
  /** Current project-area addresses in one read; absent ids have none (deleted or elsewhere). */
  currentUris(ids: {
    files: readonly string[];
    folders: readonly string[];
  }): Promise<Map<string, string>>;
}
