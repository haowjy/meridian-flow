/** Drizzle authority-generation replacement binding for checkpoint restore. */
import type { DocumentCoordinator } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  DocumentMutationPolicyError,
  replaceAuthorityGeneration,
} from "../domain/document-mutation-policy.js";
import {
  readDocumentAuthorityHead,
  replaceDocumentAuthorityHeadGeneration,
} from "./drizzle-document-authority-head.js";

type CheckpointReader = {
  getCheckpoint(id: string): Promise<{
    state: Uint8Array;
    attributionManifest?: unknown;
  } | null>;
};

export function createDrizzleAuthorityGenerationReplacement(input: {
  db: Database;
  coordinator: DocumentCoordinator;
  checkpoints: CheckpointReader;
  disconnectGeneration(documentId: DocumentId, generation: bigint): Promise<void>;
}): NonNullable<
  Parameters<
    typeof import("../checkpoints.js").createCheckpointService
  >[0]["replaceAuthorityGeneration"]
> {
  return (documentId, checkpointId) =>
    replaceAuthorityGeneration(
      {
        readMutationTarget: async () => ({
          documentId,
          generation: (await readDocumentAuthorityHead(input.db, documentId)).generation,
          doc: await input.coordinator.withDocument(documentId, async (doc) => doc),
        }),
        loadCheckpoint: async (id) => {
          const checkpoint = await input.checkpoints.getCheckpoint(id);
          return checkpoint
            ? {
                checkpointId: id,
                state: checkpoint.state,
                attributionManifest: checkpoint.attributionManifest,
              }
            : null;
        },
        unresolvedSettlements: async () => 0,
        replaceGeneration: async (checkpoint, expectedGeneration) => {
          const result = await replaceDocumentAuthorityHeadGeneration(input.db, {
            documentId,
            checkpointId: Number(checkpoint.checkpointId),
            expectedGeneration,
          });
          if (result.ok) return result.generation;
          throw new DocumentMutationPolicyError(
            result.code === "authority_head_busy"
              ? "authority_head_busy"
              : result.code === "checkpoint_incomplete"
                ? "checkpoint_incomplete"
                : "invalid_mutation",
            `Durable authority head generation replacement failed: ${result.code}`,
          );
        },
        disconnectGeneration: (generation) => input.disconnectGeneration(documentId, generation),
      },
      checkpointId,
    );
}
