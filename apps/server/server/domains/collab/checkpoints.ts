/** Checkpoint, restore, and listing service for collab documents. */
import type { DocumentCoordinator } from "@meridian/agent-edit/integration";
import { isDocumentNotFoundError } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { Err, Ok, type Result } from "../../shared/result.js";
import type { CheckpointInfo, CollabDomain, SyncError, UpdateOrigin } from "./contracts.js";
import type { AuthorityGenerationReplacement } from "./domain/document-mutation-policy.js";

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
  createCheckpoint(
    docId: string,
    state: Uint8Array,
    reason: string,
    upToSeq: number,
  ): Promise<string>;
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
  coordinator: DocumentCoordinator;
  store: CheckpointStore;
  latestUpdateSeq(documentId: string): Promise<number>;
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
        const { state, upToSeq } = await deps.coordinator.withDocument(documentId, async (doc) => {
          const upToSeq = await deps.latestUpdateSeq(documentId);
          // upToSeq must be ≤ the updates reflected in state; any later
          // update is replayed after the checkpoint, which is safe in Yjs.
          return { state: Y.encodeStateAsUpdate(doc), upToSeq };
        });
        return Ok(await deps.store.createCheckpoint(documentId, state, reason, upToSeq));
      } catch (cause) {
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
