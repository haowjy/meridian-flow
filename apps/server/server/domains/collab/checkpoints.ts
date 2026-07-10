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
import type { CheckpointInfo, CollabDomain, SyncError, UpdateOrigin } from "./index.js";

const SYSTEM_ORIGIN: UpdateOrigin = { type: "system" };

type CheckpointRecord = {
  id: string;
  documentId: string;
  state: Uint8Array;
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
  serializeDoc(doc: Y.Doc): string;
  setMarkdown(input: {
    documentId: DocumentId;
    markdown: string;
    origin: UpdateOrigin;
  }): Promise<Result<unknown, SyncError>>;
};

type CheckpointServiceDeps = {
  coordinator: DocumentCoordinator;
  store: CheckpointStore;
  latestUpdateSeq(documentId: string): Promise<number>;
  markdownDocuments: CheckpointMarkdownDocuments;
  notices?: NoticePort;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
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
        const { before, beforeContentRef } = await deps.coordinator.withDocument(
          documentId,
          async (liveDoc) => ({
            before: snapshotBlocks(toDocHandle(liveDoc), deps.model, deps.codec),
            beforeContentRef: await deps.latestUpdateSeq(documentId),
          }),
        );
        const after = snapshotBlocks(toDocHandle(restored), deps.model, deps.codec);
        const result = await deps.markdownDocuments.setMarkdown({
          documentId: documentId as DocumentId,
          markdown: deps.markdownDocuments.serializeDoc(restored),
          origin: SYSTEM_ORIGIN,
        });
        if (!result.ok) return result;
        const afterHashes = new Set(after.map(({ hash }) => hash));
        const discarded = before.filter(({ hash }) => !afterHashes.has(hash));
        await deps.notices?.record({
          kind: "checkpoint_sweep",
          scope: { kind: "document", documentId },
          writerVisible: true,
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
            beforeContentRef,
          },
        });
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
