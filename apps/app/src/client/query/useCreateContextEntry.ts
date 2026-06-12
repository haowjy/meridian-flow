// @ts-nocheck

import type { WorkbenchContextTreeScheme } from "@meridian/contracts/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createContextEntry } from "@/client/api/workbenches-api";

import { workbenchQueryKeys } from "./workbench-query-keys";

/**
 * Mutation hook for creating a file or folder inside the given scheme's
 * context tree.
 *
 * On success, invalidates the cached context tree for that scheme so the new
 * entry appears in `ContextTreePanel` on the next read.
 */
export function useCreateContextEntry(workbenchId: string, scheme: WorkbenchContextTreeScheme) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { type: "file" | "folder"; path: string; content?: string }) =>
      createContextEntry(workbenchId, scheme, args),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workbenchQueryKeys.contextTree(workbenchId, scheme),
      });
    },
  });
}
