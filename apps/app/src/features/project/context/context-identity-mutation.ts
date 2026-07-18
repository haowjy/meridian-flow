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

export interface ContextIdentityMutationService {
  materialized(projectId: string, result: CreateUntitledContextDocumentResponse): Promise<void>;
  move(
    documentId: string,
    projectId: string,
    source: ContextLocation,
    desired: DesiredIdentity,
  ): Promise<{ result: MoveContextEntryResult; isLatest: boolean }>;
}

type DocumentOperation = {
  generation: number;
  tail: Promise<void>;
  canonicalLocation?: ContextLocation;
};

const sharedServices = new WeakMap<QueryClient, ContextIdentityMutationService>();

export function createContextIdentityMutationService(
  queryClient: QueryClient,
  move: typeof moveContextEntry = moveContextEntry,
) {
  if (move === moveContextEntry) {
    const shared = sharedServices.get(queryClient);
    if (shared) return shared;
  }
  const operations = new Map<string, DocumentOperation>();
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

  const service: ContextIdentityMutationService = {
    materialized(projectId: string, result: CreateUntitledContextDocumentResponse) {
      return invalidate(projectId, [result]);
    },

    async move(
      documentId: string,
      projectId: string,
      source: ContextLocation,
      desired: DesiredIdentity,
    ): Promise<{ result: MoveContextEntryResult; isLatest: boolean }> {
      const operation = operations.get(documentId) ?? { generation: 0, tail: Promise.resolve() };
      const generation = ++operation.generation;
      const run = operation.tail.then(async () => {
        const actualSource = operation.canonicalLocation ?? source;
        const { destination } = desired;
        const currentName = actualSource.path.slice(actualSource.path.lastIndexOf("/") + 1);
        const result = await move(projectId, actualSource.scheme, {
          path: actualSource.path.replace(/^\/+/, ""),
          ...(actualSource.workId ? { sourceWorkId: actualSource.workId } : {}),
          destinationScheme: destination.scheme,
          destinationFolderPath: destination.folderPath.replace(/^\/+/, ""),
          ...(destination.workId ? { destinationWorkId: destination.workId } : {}),
          ...(desired.name !== currentName ? { newName: desired.name } : {}),
        });
        if (result.status === "moved") {
          const canonicalLocation = {
            scheme: result.scheme,
            path: result.path,
            ...(destination.workId ? { workId: destination.workId } : {}),
          };
          operation.canonicalLocation = canonicalLocation;
          await invalidate(projectId, [actualSource, canonicalLocation]);
        }
        return result;
      });
      operation.tail = run.then(
        () => undefined,
        () => undefined,
      );
      operations.set(documentId, operation);
      return run.then((result) => ({ result, isLatest: generation === operation.generation }));
    },
  };

  if (move === moveContextEntry) sharedServices.set(queryClient, service);
  return service;
}
