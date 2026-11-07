/** Live destination lookup used by import upload admission. */
import type { ProjectContextFsScheme } from "./context-port.js";

export interface ContextImportDestinationLookup {
  /** An existing area folder by path; null when its source or any segment is absent. */
  findFolder(
    scheme: ProjectContextFsScheme,
    segments: readonly string[],
  ): Promise<{ folderId: string } | null>;
}
