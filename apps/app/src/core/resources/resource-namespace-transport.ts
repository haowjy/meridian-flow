/** Account-fenced document namespace transport; durable ownership and retry scheduling stay upstream. */
import type { NamespaceRequest, ResourceNamespaceTransport } from "@meridian/resource-replica";
import {
  createUntitledContextDocument,
  deleteContextEntry,
  getContextOperationReceipt,
  moveContextEntry,
} from "@/client/api/projects-api";
import { contextRequestOptionsForScheme } from "@/client/query/context-request-options";

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
    const receipt = await getContextOperationReceipt(projectId, request.body.operationId);
    requireOpen();
    return receipt ? { kind: "operation", receipt } : null;
  };
  return Object.freeze({
    accountId,
    readOutcome,
    async submit(projectId: string, request: NamespaceRequest) {
      requireOpen();
      if (request.kind === "create") {
        const result = await createUntitledContextDocument(projectId, "unfiled", request.body);
        requireOpen();
        return { kind: "create" as const, result };
      }
      if (request.kind === "move") {
        await moveContextEntry(projectId, request.scheme, request.body);
      } else {
        await deleteContextEntry(
          projectId,
          request.scheme,
          request.body,
          contextRequestOptionsForScheme(request.scheme, request.workId),
        );
      }
      // A missing receipt remains uncertainty; never synthesize one from UI metadata.
      return readOutcome(projectId, request);
    },
  });
}
