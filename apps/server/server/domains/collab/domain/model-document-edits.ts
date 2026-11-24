import type { DocumentEditRequest, DocumentEdits } from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts";
import type { AgentCallContext } from "./agent-edit-cores.js";
import type { TurnInverseService } from "./turn-inverse-service.js";

/** The model's edit list, undo and revert, on the turn-inverse service, as the call's chat. */
export function createModelDocumentEdits(input: {
  service(): TurnInverseService;
}): DocumentEdits<AgentCallContext> {
  function query(request: DocumentEditRequest<AgentCallContext> & { command: { file: string } }) {
    const { context } = request;
    return {
      model: true as const,
      documentIds: [request.documentId as DocumentId],
      threadId: request.threadId as ThreadId,
      // A deleted document has no address of its own: results name it by the model's path.
      path: request.command.file,
      turnId: context.turnId as TurnId | undefined,
      responseIdentity: context.responseIdentity,
      toolCallId: context.tool_use_id,
      principal: context.grant.principal,
      view: context.linkView ?? { kind: "live" as const },
    };
  }
  return {
    execute: (request) => input.service().modelInverse(query(request), request.command),
    read: (request) => input.service().modelEdits(query(request), request.command.before),
  };
}
