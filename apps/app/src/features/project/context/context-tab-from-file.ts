/**
 * context-tab-from-file — adapter from context-tree file metadata to ContextTab.
 *
 * Keeps desktop and phone context navigation on the same tab construction path
 * so file classification, schema type, and viewer metadata cannot drift between
 * shells.
 */
import type {
  ProjectContextTreeFile,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";

import type { ServerContextTab } from "@/client/stores";

export function contextTabFromFile(
  scheme: ProjectContextTreeScheme,
  file: ProjectContextTreeFile,
  workId?: string | null,
): ServerContextTab {
  const base = {
    documentId: file.documentId,
    scheme,
    path: file.path,
    name: file.name,
    ...(isWorkScopedProjectContextScheme(scheme) && workId ? { workId } : {}),
  };
  return {
    ...base,
    ...(file.editable
      ? {
          kind: "tracked" as const,
          editable: true as const,
          filetype: file.filetype,
          schemaType: file.schemaType,
        }
      : {
          kind: "viewer" as const,
          editable: false as const,
          fileType: file.fileType,
          mimeType: file.mimeType,
        }),
  };
}
