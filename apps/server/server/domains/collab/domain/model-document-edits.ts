// Composition adapter binds model history commands to the caller's current destination.

import type { DocumentEditRequest, DocumentEdits } from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts";
import type { ApplicationDraftStore } from "./ports/application-draft-store.js";
import type { LiveDocumentCoordinator } from "./ports/live-document-coordinator.js";
import type { TurnInverseService } from "./turn-inverse-service.js";

export function createModelDocumentEdits(input: {
  service(): TurnInverseService;
  drafts: ApplicationDraftStore;
  coordinator: Pick<LiveDocumentCoordinator, "withDocument">;
}): DocumentEdits {
  async function query(request: DocumentEditRequest & { command: { file: string } }) {
    const documentId = request.documentId as DocumentId;
    const view = request.context.linkView;
    let draftId: string | null = null;
    if (view?.kind === "branch") {
      const documentDraft = await input.coordinator.withDocument(documentId, (liveDoc) =>
        input.drafts.ensureDocumentDraft({ documentId, branchId: view.branchId, liveDoc }),
      );
      draftId = documentDraft.draftId;
    }
    return {
      model: true as const,
      draftId,
      documentIds: [documentId],
      threadId: request.threadId as ThreadId,
      // A deleted document has no address of its own: results name it by the model's path.
      path: request.command.file,
      turnId: request.context.turnId as TurnId | undefined,
      responseIdentity: request.context.responseIdentity,
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
