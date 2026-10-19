/** Checkpoint, restore, and listing service for collab documents. */

import { isDocumentNotFoundError } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { Err, Ok, type Result } from "../../shared/result.js";
import type { CheckpointInfo, CollabDomain, SyncError, UpdateOrigin } from "./contracts.js";
import type { CapturedCheckpointCut } from "./domain/checkpoint-cut.js";
import { documentAuthority, RetiredDocumentHandleError } from "./domain/document-handle.js";
import type { AuthorityGenerationReplacement } from "./domain/document-mutation-policy.js";
import type { CheckpointJournal } from "./domain/ports/checkpoint-authority.js";
import type { LiveDocumentCoordinator } from "./domain/ports/live-document-coordinator.js";

const SYSTEM_ORIGIN: UpdateOrigin = { type: "system" };

type CheckpointRecord = {
  id: string;
  documentId: string;
  state: Uint8Array;
  attributionManifest?: unknown;
  reason: string;
  createdAt: string;
};

type CheckpointStore = {
  createCheckpoint(cut: CapturedCheckpointCut, reason: string): Promise<string | null>;
  getCheckpoint(id: string): Promise<CheckpointRecord | null>;
  listCheckpoints(docId: string): Promise<CheckpointRecord[]>;
};

type CheckpointMarkdownDocuments = {
  restoreFromYDoc(
    documentId: DocumentId,
    snapshot: Y.Doc,
    origin: UpdateOrigin,
  ): Promise<Result<unknown, SyncError>>;
};

type CheckpointServiceDeps = {
  coordinator: Pick<LiveDocumentCoordinator, "withDocument" | "recover">;
  store: CheckpointStore;
  journal: Pick<CheckpointJournal, "captureCheckpoint">;
  markdownDocuments: CheckpointMarkdownDocuments;
  replaceAuthorityGeneration?(
    documentId: DocumentId,
    checkpointId: string,
  ): ReturnType<AuthorityGenerationReplacement>;
};

export type CheckpointService = Pick<CollabDomain, "checkpoint" | "restore" | "listCheckpoints">;

export function createCheckpointService(deps: CheckpointServiceDeps): CheckpointService {
  return {
    async checkpoint(documentId, reason) {
      try {
        const cut = await deps.coordinator.withDocument(documentId, (doc) =>
          deps.journal.captureCheckpoint(documentId, documentAuthority(doc)),
        );
        if (!cut) return Err({ code: "stale_generation", documentId });
        const id = await deps.store.createCheckpoint(cut, reason);
        return id === null ? Err({ code: "stale_generation", documentId }) : Ok(id);
      } catch (cause) {
        if (cause instanceof RetiredDocumentHandleError)
          return Err({ code: "stale_generation", documentId });
        if (isDocumentNotFoundError(cause)) return Err({ code: "not_found", documentId });
        throw cause;
      }
    },

    async restore(documentId, checkpointId) {
      const checkpoint = await deps.store.getCheckpoint(checkpointId);
      if (!checkpoint || checkpoint.documentId !== documentId) {
        return Err({ code: "checkpoint_not_found", checkpointId });
      }
      try {
        const restored = createCollabYDoc({ gc: false });
        Y.applyUpdate(restored, checkpoint.state);
        if (deps.replaceAuthorityGeneration) {
          await deps.replaceAuthorityGeneration(documentId as DocumentId, checkpointId);
        } else {
          const result = await deps.markdownDocuments.restoreFromYDoc(
            documentId as DocumentId,
            restored,
            SYSTEM_ORIGIN,
          );
          if (!result.ok) return result;
        }
        return Ok(undefined);
      } catch (cause) {
        return Err({
          code: "corrupt_state",
          documentId,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },

    async listCheckpoints(documentId) {
      const checkpoints = await deps.store.listCheckpoints(documentId);
      return Ok(
        checkpoints.map(
          (checkpoint): CheckpointInfo => ({
            id: checkpoint.id,
            reason: checkpoint.reason,
            createdAt: checkpoint.createdAt,
          }),
        ),
      );
    },
  };
}
