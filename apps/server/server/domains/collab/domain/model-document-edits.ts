// Composition adapter binds model history commands to the caller's current destination.

import type {
  BlockOriginMap,
  DocumentEditRequest,
  DocumentEdits,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts";
import { DraftNotFoundError } from "./draft-resolver.js";
import { blockOriginsFromDraftSeed } from "./draft-store.js";
import { currentInversePrincipal } from "./inverse-principal.js";
import type { ApplicationDraftStore } from "./ports/application-draft-store.js";
import type { TurnInverseService } from "./turn-inverse-service.js";

export function createModelDocumentEdits(input: {
  service(): TurnInverseService;
  drafts: ApplicationDraftStore;
}): DocumentEdits {
  async function query(
    request: DocumentEditRequest & { command: { file: string } },
    ensure: boolean,
  ) {
    const documentId = request.documentId as DocumentId;
    const view = request.context.linkView;
    const version = request.context.documentVersion;
    if (!version) throw new Error("Model edit history requires an explicitly routed version");
    let draftId: string | null = null;
    let blockOrigins: BlockOriginMap | undefined;
    if (version === "draft" && view?.kind === "branch") {
      if (ensure) {
        const documentDraft = await input.drafts.ensureLiveDocumentDraft({
          documentId,
          branchId: view.branchId,
        });
        draftId = documentDraft.draftId;
        blockOrigins = blockOriginsFromDraftSeed(documentDraft.seed) ?? undefined;
      } else {
        try {
          const documentDraft = await input.drafts.resolveWorkDraftForThread(
            documentId,
            request.threadId as ThreadId,
          );
          draftId = documentDraft.draftId;
        } catch (cause) {
          if (!(cause instanceof DraftNotFoundError)) throw cause;
        }
      }
    }
    return {
      query: {
        model: true as const,
        draftId,
        documentIds: [documentId],
        threadId: request.threadId as ThreadId,
        // A deleted document has no address of its own: results name it by the model's path.
        path: request.command.file,
        turnId: request.context.turnId as TurnId | undefined,
        responseIdentity: request.context.responseIdentity,
        toolCallId: request.context.tool_use_id,
        principal: currentInversePrincipal(),
      },
      blockOrigins,
    };
  }
  return {
    async execute(request) {
      const resolved = await query(request, true);
      const result = await input.service().modelInverse(resolved.query, request.command);
      return result.status === "success" && resolved.blockOrigins
        ? { ...result, blockOrigins: resolved.blockOrigins }
        : result;
    },
    async read(request) {
      const resolved = await query(request, false);
      return input.service().modelEdits(resolved.query, request.command.before);
    },
  };
}
