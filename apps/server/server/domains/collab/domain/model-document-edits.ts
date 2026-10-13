// Composition adapter binds model history commands to the caller's current destination.
import type {
  DocumentCoordinator,
  DocumentEditRequest,
  DocumentEdits,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts";
import type { ApplicationBranchStore } from "./ports/application-branch-store.js";
import type { TurnInverseService } from "./turn-inverse-service.js";

export function createModelDocumentEdits(input: {
  service(): TurnInverseService;
  branches: ApplicationBranchStore;
  coordinator: DocumentCoordinator;
}): DocumentEdits {
  async function query(request: DocumentEditRequest) {
    const documentId = request.documentId as DocumentId;
    const view = request.context.linkView;
    let branchId: string | null = null;
    if (view?.kind === "draft") {
      const branch = await input.coordinator.withDocument(documentId, (liveDoc) =>
        input.branches.ensureDraftBranch({ documentId, draftId: view.draftId, liveDoc }),
      );
      branchId = branch.branchId;
    }
    return {
      model: true as const,
      branchId,
      documentIds: [documentId],
      threadId: request.threadId as ThreadId,
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
