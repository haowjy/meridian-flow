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

import type { ContextTab } from "@/client/stores";

export function contextTabFromFile(
  scheme: ProjectContextTreeScheme,
  file: ProjectContextTreeFile,
): ContextTab {
  return {
    documentId: file.documentId,
    scheme,
    path: file.path,
    name: file.name,
    ...(file.editable
      ? {
          editable: true as const,
          filetype: file.filetype,
          schemaType: file.schemaType,
        }
      : {
          editable: false as const,
          fileType: file.fileType,
          mimeType: file.mimeType,
        }),
  };
}
