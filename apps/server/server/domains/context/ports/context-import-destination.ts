import type { ProjectContextFsScheme } from "./context-port.js";

export interface ContextImportDestinationLookup {
  findFolder(
    scheme: ProjectContextFsScheme,
    segments: readonly string[],
  ): Promise<{ folderId: string } | null>;
}
