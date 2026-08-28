import type {
  DeleteContextEntryRequest,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { useMutation } from "@tanstack/react-query";

import { deleteContextEntry } from "@/client/api/projects-api";
import { contextRequestOptionsForScheme } from "./context-request-options";

/**
 * Mutation hook for deleting a file or folder from a context scheme's tree.
 *
 * Cache invalidation belongs to the feature orchestrator, after synchronous
 * removal-command admission.
 */
export function useDeleteContextEntry(projectId: string, scheme: ProjectContextTreeScheme) {
  return useMutation({
    mutationFn: (args: DeleteContextEntryRequest & { workId: string | null }) =>
      deleteContextEntry(
        projectId,
        scheme,
        args.expected.kind === "file"
          ? { path: args.path, expected: args.expected }
          : { path: args.path, expected: { kind: "folder" } },
        contextRequestOptionsForScheme(scheme, args.workId),
      ),
  });
}
