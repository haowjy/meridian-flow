/** Context identity transport plus the cache receipts every caller must emit. */

import type {
  CreateUntitledContextDocumentResponse,
  MoveContextEntryResult,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { moveContextEntry } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import type { DesiredIdentity } from "./identity-location";

type ContextLocation = {
  scheme: ProjectContextTreeScheme;
  path: string;
  workId?: string;
};

export type ContextIdentityMutationService = ReturnType<
  typeof createContextIdentityMutationService
>;

export function createContextIdentityMutationService(
  queryClient: QueryClient,
  move: typeof moveContextEntry = moveContextEntry,
) {
  async function invalidate(projectId: string, locations: readonly ContextLocation[]) {
    const unique = new Map(
      locations.map((location) => [
        JSON.stringify([location.scheme, location.workId ?? null]),
        location,
      ]),
    );
    await Promise.all(
      [...unique.values()].map((location) =>
        queryClient.invalidateQueries({
          queryKey: projectQueryKeys.contextTree(projectId, location.scheme, location.workId),
        }),
      ),
    );
  }

  return {
    materialized(projectId: string, result: CreateUntitledContextDocumentResponse) {
      return invalidate(projectId, [result]);
    },

    async move(
      projectId: string,
      source: ContextLocation,
      desired: DesiredIdentity,
    ): Promise<MoveContextEntryResult> {
      const { destination } = desired;
      const currentName = source.path.slice(source.path.lastIndexOf("/") + 1);
      const result = await move(projectId, source.scheme, {
        path: source.path.replace(/^\/+/, ""),
        ...(source.workId ? { sourceWorkId: source.workId } : {}),
        destinationScheme: destination.scheme,
        destinationFolderPath: destination.folderPath.replace(/^\/+/, ""),
        ...(destination.workId ? { destinationWorkId: destination.workId } : {}),
        ...(desired.name !== currentName ? { newName: desired.name } : {}),
      });
      if (result.status === "moved") {
        await invalidate(projectId, [
          source,
          {
            scheme: result.scheme,
            path: result.path,
            ...(destination.workId ? { workId: destination.workId } : {}),
          },
        ]);
      }
      return result;
    },
  };
}
