import type { DocumentEditRequest, DocumentEdits } from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts";
import { currentInversePrincipal } from "./inverse-principal.js";
import type { TurnInverseService } from "./turn-inverse-service.js";

export function createModelDocumentEdits(input: { service(): TurnInverseService }): DocumentEdits {
  function query(request: DocumentEditRequest & { command: { file: string } }) {
    return {
      model: true as const,
      documentIds: [request.documentId as DocumentId],
      threadId: request.threadId as ThreadId,
      path: request.command.file,
      turnId: request.context.turnId as TurnId | undefined,
      responseIdentity: request.context.responseIdentity,
      toolCallId: request.context.tool_use_id,
      principal: currentInversePrincipal(),
    };
  }
  return {
    execute: (request) => input.service().modelInverse(query(request), request.command),
    read: (request) => input.service().modelEdits(query(request), request.command.before),
  };
}
