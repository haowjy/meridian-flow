// Composition adapter binds model history commands to the caller's current destination.

import type { DocumentEditRequest, DocumentEdits } from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts";
import { currentInversePrincipal } from "./inverse-principal.js";
import type { TurnInverseService } from "./turn-inverse-service.js";

export function createModelDocumentEdits(input: { service(): TurnInverseService }): DocumentEdits {
  async function query(request: DocumentEditRequest & { command: { file: string } }) {
    const documentId = request.documentId as DocumentId;
    return {
      model: true as const,
      draftId: null,
      documentIds: [documentId],
      threadId: request.threadId as ThreadId,
      // A deleted document has no address of its own: results name it by the model's path.
      path: request.command.file,
      turnId: request.context.turnId as TurnId | undefined,
      responseIdentity: request.context.responseIdentity,
      toolCallId: request.context.tool_use_id,
      principal: currentInversePrincipal(),
    };
  }
  return {
    async execute(request) {
      return input.service().modelInverse(await query(request), request.command);
    },
    async read(request) {
      return input.service().modelEdits(await query(request), request.command.before);
    },
  };
}
