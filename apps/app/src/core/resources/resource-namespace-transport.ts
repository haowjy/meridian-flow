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
import { lookupProjectContextAvailability } from "@/client/query/project-context-availability";

/** How long one namespace request may hold its runner before the wait gives up. */
export const NAMESPACE_REQUEST_DEADLINE_MS = 20_000;

/**
 * Bound one wait on the network. The deadline ends the wait, not the uncertainty: the request that
 * was sent may still commit, so the caller's recorded attempt stays replayable and is retried
 * as the same request with the same operation id, never replaced. The race is explicit because a
 * stalled transport need not honour the abort.
 */
function withinDeadline<T>(
  epoch: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  const signal = AbortSignal.any([epoch, deadline.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new TypeError("Namespace request timed out");
      deadline.abort(error);
      reject(error);
    }, NAMESPACE_REQUEST_DEADLINE_MS);
  });
  return Promise.race([run(signal), expired]).finally(() => clearTimeout(timer));
}

export function createResourceNamespaceTransport(
  accountId: string,
  epoch: AbortSignal,
): ResourceNamespaceTransport {
  const requireOpen = () => {
    if (epoch.aborted) throw new Error("Resource namespace transport is closing");
  };
  const readOutcomeWithin = async (
    signal: AbortSignal,
    projectId: string,
    request: NamespaceRequest,
  ) => {
    requireOpen();
    // Create has no operation receipt. Replay uses the recorded document ID/request,
    // while current availability is a separate observation, not a historical outcome.
    if (request.kind === "create") return null;
    const receipt = await getContextOperationReceipt(projectId, request.body.operationId, {
      signal,
    });
    requireOpen();
    return receipt ? { kind: "operation" as const, receipt } : null;
  };
  const readOutcome: ResourceNamespaceTransport["readOutcome"] = (projectId, request) =>
    withinDeadline(epoch, (signal) => readOutcomeWithin(signal, projectId, request));
  return Object.freeze({
    accountId,
    readOutcome,
    lookupIdentity: (projectId: string, identity: { kind: "file" | "folder"; id: string }) =>
      withinDeadline(epoch, (signal) => lookupIdentityWithin(signal, projectId, identity)),
    submit: (projectId: string, request: NamespaceRequest) =>
      withinDeadline(epoch, (signal) => submitWithin(signal, projectId, request)),
  });

  async function lookupIdentityWithin(
    signal: AbortSignal,
    projectId: string,
    identity: { kind: "file" | "folder"; id: string },
  ): Promise<NamespaceIdentityAvailability> {
    requireOpen();
    const resolution =
      identity.kind === "folder"
        ? (await lookupProjectContextAvailability(projectId, [], signal, [identity.id]))
            .folderResolutions?.[0]
        : (await lookupProjectContextAvailability(projectId, [identity.id], signal)).resolutions[0];
    requireOpen();
    if (!resolution) throw new TypeError("Availability response omitted requested identity");
    if (resolution.kind === "deleted")
      return {
        kind: "deleted",
        generation: resolution.generation,
        observationVersion: resolution.observationVersion,
      };
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
      observationVersion: entry.observationVersion,
      locationVersion: entry.locationVersion,
      rank: entry.rank,
      ...(entry.kind === "folder" ? { orderPolicy: entry.orderPolicy } : {}),
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
  }

  async function submitWithin(signal: AbortSignal, projectId: string, request: NamespaceRequest) {
    requireOpen();
    if (request.kind === "create") {
      const result = await createUntitledContextDocument(
        projectId,
        "unfiled",
        request.body,
        undefined,
        { signal },
      );
      requireOpen();
      return { kind: "create" as const, result };
    }
    try {
      if (request.kind === "move") {
        await moveContextEntry(projectId, request.scheme, request.body, { signal });
      } else {
        await deleteContextEntry(
          projectId,
          request.scheme,
          request.body,
          contextRequestOptionsForScheme(
            request.scheme,
            contextOwner(request.workId, request.rootThreadId),
          ),
          { signal },
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
      const outcome = await readOutcomeWithin(signal, projectId, request);
      if (outcome) return outcome;
      throw error;
    }
    // A missing receipt remains uncertainty; never synthesize one from UI metadata.
    return readOutcomeWithin(signal, projectId, request);
  }
}
