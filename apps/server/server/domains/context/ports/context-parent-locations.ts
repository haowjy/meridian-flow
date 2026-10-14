/** Identity-resolved folders in a fixed set of project areas, locked and reread under the namespace lock. */
import type { ProjectContextFsScheme } from "./context-port.js";

export interface ContextLockedParent {
  sourceId: string;
  folderId: string | null;
  uri: string;
  children: { kind: "folder" | "file"; name: string; extension: string }[];
}

/** The folder moved to another source between the first read and the lock. Retry from its identity. */
export class ContextParentMovedError extends Error {}

export interface ContextParentLocations {
  /** An existing area folder by path segments; null when the area source or any segment is absent. */
  findFolder(
    scheme: ProjectContextFsScheme,
    segments: readonly string[],
  ): Promise<{ sourceId: string; folderId: string | null } | null>;
  /** Provision the area's source (under its namespace lock) when it does not exist yet. */
  ensureSource(scheme: ProjectContextFsScheme): Promise<string>;
  lockParent(sourceId: string, folderId: string | null): Promise<ContextLockedParent | null>;
  lockDocument(id: string): Promise<boolean>;
  currentUri(id: string, kind: "folder" | "file"): Promise<string | null>;
  /** Current area addresses in one read; absent ids have none (deleted or elsewhere). */
  currentUris(ids: {
    files: readonly string[];
    folders: readonly string[];
  }): Promise<Map<string, string>>;
}
