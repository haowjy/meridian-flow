// Composition adapter binds model history commands to the caller's current destination.

import { randomUUID } from "node:crypto";
import type {
  BlockOriginMap,
  DocumentEditRequest,
  DocumentEdits,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts";
import { DraftNotFoundError } from "./draft-resolver.js";
import type { ApplicationDraftStore } from "./ports/application-draft-store.js";
import type { LiveDocumentCoordinator } from "./ports/live-document-coordinator.js";
import type { TurnInverseService } from "./turn-inverse-service.js";

export function createModelDocumentEdits(input: {
  service(): TurnInverseService;
  drafts: ApplicationDraftStore;
  coordinator: Pick<LiveDocumentCoordinator, "withDocument">;
}): DocumentEdits {
  async function query(
    request: DocumentEditRequest & { command: { file: string } },
    ensure: boolean,
  ) {
    const documentId = request.documentId as DocumentId;
    const view = request.context.linkView;
    let draftId: string | null = null;
    let blockOrigins: BlockOriginMap | undefined;
    if (view?.kind === "branch") {
      if (ensure) {
        const documentDraft = await input.coordinator.withDocument(documentId, (liveDoc) =>
          input.drafts.ensureDocumentDraft({ documentId, branchId: view.branchId, liveDoc }),
        );
        draftId = documentDraft.draftId;
        blockOrigins = originsOf(documentDraft.seed?.origins);
      } else {
        try {
          const documentDraft = await input.drafts.resolveWorkDraftForThread(
            documentId,
            request.threadId as ThreadId,
          );
          draftId = documentDraft.draftId;
          blockOrigins = originsOf(documentDraft.seed?.origins);
        } catch (cause) {
          if (cause instanceof DraftNotFoundError) return null;
          throw cause;
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
      },
      blockOrigins,
    };
  }
  return {
    async execute(request) {
      const resolved = await query(request, true);
      if (!resolved) throw new Error("A draft inverse did not resolve its ensured draft");
      const result = await input.service().modelInverse(resolved.query, request.command);
      return result.status === "success" && resolved.blockOrigins
        ? { ...result, blockOrigins: resolved.blockOrigins }
        : result;
    },
    async read(request) {
      const resolved = await query(request, false);
      return resolved
        ? input.service().modelEdits(resolved.query, request.command.before)
        : {
            status: "success",
            message: `This chat has no edits in a draft of ${request.command.file}.`,
            actionId: randomUUID(),
            room: null,
          };
    },
  };
}

function originsOf(
  origins: Readonly<Record<string, string>> | undefined,
): BlockOriginMap | undefined {
  if (!origins) return undefined;
  return new Map(
    Object.entries(origins).map(([target, origin]) => {
      const [clientID, clock] = origin.split(":").map(Number);
      return [target, { clientID, clock }];
    }),
  );
}
