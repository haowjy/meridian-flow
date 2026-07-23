/** Checkpoint, restore, and listing service for collab documents. */
import type {
  AgentEditCodec,
  DocumentCoordinator,
  YProsemirrorDocumentModel,
} from "@meridian/agent-edit";
import { isDocumentNotFoundError, snapshotBlocks, toDocHandle } from "@meridian/agent-edit";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { Err, Ok, type Result } from "../../shared/result.js";
import type { NoticePort } from "../notices/index.js";
import type { DocumentAuthority } from "./domain/document-authority.js";
import type { CheckpointInfo, CollabDomain, SyncError, UpdateOrigin } from "./index.js";

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
  notices?: NoticePort;
  model?: YProsemirrorDocumentModel;
  codec?: AgentEditCodec;
  authority?(documentId: DocumentId): DocumentAuthority;
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
        const { model, codec } = deps;
        const safetySnapshot =
          deps.notices && model && codec
            ? await deps.coordinator.withDocument(documentId, async (liveDoc) => ({
                before: snapshotBlocks(toDocHandle(liveDoc), model, codec),
                after: snapshotBlocks(toDocHandle(restored), model, codec),
                beforeContentRef: await deps.latestUpdateSeq(documentId),
              }))
            : null;
        if (deps.authority) {
          await deps.authority(documentId as DocumentId).mutate({
            kind: "authoritySnapshotReplacement",
            checkpointId,
            replaceGeneration: true,
          });
        } else {
          const result = await deps.markdownDocuments.restoreFromYDoc(
            documentId as DocumentId,
            restored,
            SYSTEM_ORIGIN,
          );
          if (!result.ok) return result;
        }
        if (safetySnapshot) {
          const afterHashes = new Set(safetySnapshot.after.map(({ hash }) => hash));
          const discarded = safetySnapshot.before.filter(({ hash }) => !afterHashes.has(hash));
          await deps.notices?.record({
            kind: "checkpoint_sweep",
            scope: { kind: "document", documentId },
            message:
              discarded.length > 0
                ? `Checkpoint restore discarded ${discarded.length} block${discarded.length === 1 ? "" : "s"}.`
                : "Checkpoint restore completed without discarding blocks.",
            data: {
              sweptBlockHashes: discarded.map(({ hash }) => hash),
              capturedDeletedBodies: discarded.map(({ hash, serialized }) => ({
                hash,
                body: serialized.slice(serialized.indexOf("|") + 1),
              })),
              beforeContentRef: safetySnapshot.beforeContentRef,
            },
          });
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
