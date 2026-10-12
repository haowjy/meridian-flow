/** Account-fenced document namespace transport; durable ownership and retry scheduling stay upstream. */
import { parseContextUri } from "@meridian/contracts/context-uri";
import { contextOwner } from "@meridian/contracts/protocol";
import {
  catalogEntryOwner,
  type NamespaceIdentityAvailability,
  type NamespaceRequest,
  type ResourceNamespaceTransport,
} from "@meridian/resource-replica";
import { httpErrorStatus, isMeridianApiError } from "@/client/api/http-client";
import {
  createUntitledContextDocument,
  deleteContextEntry,
  getContextOperationReceipt,
  moveContextEntry,
} from "@/client/api/projects-api";
import { contextRequestOptionsForScheme } from "@/client/query/context-request-options";
import {
  lookupProjectContextAvailability,
  lookupProjectFolderAvailability,
} from "@/client/query/project-context-availability";

export function createResourceNamespaceTransport(
  accountId: string,
  epoch: AbortSignal,
): ResourceNamespaceTransport {
  const requireOpen = () => {
    if (epoch.aborted) throw new Error("Resource namespace transport is closing");
  };
  const readOutcome: ResourceNamespaceTransport["readOutcome"] = async (projectId, request) => {
    requireOpen();
    // Create has no operation receipt. Replay uses the recorded document ID/request,
    // while current availability is a separate observation, not a historical outcome.
    if (request.kind === "create") return null;
    const receipt = await getContextOperationReceipt(projectId, request.body.operationId, {
      signal: epoch,
    });
    requireOpen();
    return receipt ? { kind: "operation", receipt } : null;
  };
  return Object.freeze({
    accountId,
    readOutcome,
    async lookupIdentity(
      projectId: string,
      identity: { kind: "file" | "folder"; id: string },
    ): Promise<NamespaceIdentityAvailability> {
      requireOpen();
      const resolution =
        identity.kind === "folder"
          ? await lookupProjectFolderAvailability(projectId, identity.id, epoch)
          : (await lookupProjectContextAvailability(projectId, [identity.id], epoch))
              .resolutions[0];
      requireOpen();
      if (resolution.kind === "deleted")
        return { kind: "deleted", generation: resolution.generation };
      if (resolution.kind !== "available") return { kind: "unavailable" };
      const entry = resolution.entry;
      const parsed = parseContextUri(entry.uri);
      if (
        !parsed.ok ||
        parsed.value.path !== entry.path.join("/") ||
        entry.path.at(-1) !== entry.name
      )
        throw new TypeError("Invalid namespace availability location");
      return {
        kind: "available",
        parent:
          entry.parentId === entry.sourceId
            ? {
                kind: "root",
                scheme: parsed.value.scheme,
                owner: catalogEntryOwner(entry.scope, parsed.value.authority),
              }
            : { kind: "folder", folderId: entry.parentId },
        location: {
          scheme: parsed.value.scheme,
          path: `/${parsed.value.path}`,
          name: entry.name,
          ...catalogEntryOwner(entry.scope, parsed.value.authority),
        },
      };
    },
    async submit(projectId: string, request: NamespaceRequest) {
      requireOpen();
      if (request.kind === "create") {
        const result = await createUntitledContextDocument(
          projectId,
          "unfiled",
          request.body,
          undefined,
          { signal: epoch },
        );
        requireOpen();
        return { kind: "create" as const, result };
      }
      try {
        if (request.kind === "move") {
          await moveContextEntry(projectId, request.scheme, request.body, { signal: epoch });
        } else {
          await deleteContextEntry(
            projectId,
            request.scheme,
            request.body,
            contextRequestOptionsForScheme(
              request.scheme,
              contextOwner(request.workId, request.rootThreadId),
            ),
            { signal: epoch },
          );
        }
      } catch (error) {
        // A typed final HTTP refusal proves rejection even before receipt intake.
        const status = httpErrorStatus(error);
        if (
          isMeridianApiError(error) &&
          !error.retryable &&
          status !== undefined &&
          status >= 400 &&
          status < 500
        ) {
          return {
            kind: "refusal" as const,
            operationId: request.body.operationId,
            error: error.envelope,
          };
        }
        // Bare HTTP failures and offline/timeouts still need persisted evidence.
        if (httpErrorStatus(error) === undefined) throw error;
        const outcome = await readOutcome(projectId, request);
        if (outcome) return outcome;
        throw error;
      }
      // A missing receipt remains uncertainty; never synthesize one from UI metadata.
      return readOutcome(projectId, request);
    },
  });
}
