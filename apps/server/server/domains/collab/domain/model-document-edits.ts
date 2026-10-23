// Composition adapter binds model history commands to the caller's current destination.

import { randomUUID } from "node:crypto";
import type {
  BlockOriginMap,
  DocumentEditRequest,
  DocumentEdits,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts";
import { boundDocumentAuthority } from "./document-handle.js";
import { DraftNotFoundError } from "./draft-resolver.js";
import { blockOriginsFromDraftSeed } from "./draft-store.js";
import { currentInversePrincipal } from "./inverse-principal.js";
import { liveRoom } from "./observation-rooms.js";
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
    const version = request.context.documentVersion;
    if (!version) throw new Error("Model edit history requires an explicitly routed version");
    let draftId: string | null = null;
    let blockOrigins: BlockOriginMap | undefined;
    if (version === "draft") {
      if (view?.kind !== "branch") return null;
      if (ensure) {
        const documentDraft = await input.coordinator.withDocument(documentId, (liveDoc) => {
          const authority = boundDocumentAuthority(liveDoc);
          if (!authority) throw new Error(`Live document ${documentId} has no authority binding`);
          return input.drafts.ensureDocumentDraft({
            documentId,
            branchId: view.branchId,
            liveDoc,
            liveRoom: liveRoom(documentId, authority.generation),
          });
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
        toolCallId: request.context.tool_use_id,
        principal: currentInversePrincipal(),
      },
      blockOrigins,
    };
  }
  return {
    async execute(request) {
      const resolved = await query(request, true);
      if (!resolved) return absentDraftInverse(request.command);
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

function absentDraftInverse(command: { command: "undo" | "redo" | "revert"; file: string }) {
  switch (command.command) {
    case "undo":
      return {
        status: "nothing_to_undo" as const,
        message: `You have no edits to undo in ${command.file}. Read it and make a new replace if needed.`,
      };
    case "redo":
      return {
        status: "nothing_to_redo" as const,
        message: `Nothing of yours to redo in ${command.file}. A new edit clears redo here. Read it and make a new replace if needed.`,
      };
    case "revert":
      return {
        status: "nothing_to_revert" as const,
        message: `Nothing is left to reverse in ${command.file}. Read it and make a new replace.`,
      };
  }
}
