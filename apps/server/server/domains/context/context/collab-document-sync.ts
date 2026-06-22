/**
 * Collab-backed markdown helpers for ContextFS. The adapter keeps ContextFS
 * provenance vocabulary out of the collab domain while routing agent/human
 * writes through the richer write APIs that return attribution metadata.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type {
  CollabDomain,
  DocumentWriteOrigin,
  SyncError,
  UpdateOrigin,
} from "../../collab/index.js";
import type { AdapterFault } from "../ports/context-adapter.js";
import type { WriteProvenance } from "../ports/context-port.js";

export type ContextCollabDomain = Pick<
  CollabDomain,
  "readAsMarkdown" | "writeFromMarkdown" | "writeDocument" | "editDocument"
>;

export type CollabMarkdownResult =
  | { ok: true; markdown: string; updateSeq?: number }
  | { ok: false; error: AdapterFault };

function syncFault(error: SyncError): AdapterFault {
  switch (error.code) {
    case "not_found":
      return {
        code: "io_error",
        message: `Yjs document not found: ${error.documentId}`,
      };
    case "checkpoint_not_found":
      return { code: "io_error", message: `Yjs checkpoint not found: ${error.checkpointId}` };
    case "corrupt_state":
      return { code: "io_error", message: error.message };
  }
}

function provenanceToWriteOrigin(provenance: WriteProvenance): DocumentWriteOrigin | null {
  if (provenance.type === "agent") {
    return { type: "agent", actorTurnId: provenance.turnId };
  }
  if (provenance.type === "human") {
    return { type: "user", actorUserId: provenance.userId };
  }
  return null;
}

function provenanceToUpdateOrigin(provenance: WriteProvenance | undefined): UpdateOrigin {
  if (!provenance) return { type: "system" };
  if (provenance.type === "agent") return { type: "agent", actorTurnId: provenance.turnId };
  if (provenance.type === "human") return { type: "user", userId: provenance.userId };
  if (provenance.type === "import") {
    return {
      type: "import",
      userId: provenance.userId,
      source: provenance.source,
      filename: provenance.filename,
      sourceId: provenance.sourceId,
    };
  }
  return { type: "system" };
}

function threadIdFromProvenance(provenance: WriteProvenance | undefined): ThreadId | undefined {
  if (provenance?.type === "agent" || provenance?.type === "human") {
    return provenance.threadId;
  }
  return undefined;
}

function thrownFault(error: unknown): AdapterFault {
  return {
    code: "io_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function writeCollabMarkdown(input: {
  documentSync: ContextCollabDomain;
  documentId: string;
  content: string;
  provenance?: WriteProvenance;
}): Promise<CollabMarkdownResult> {
  const { documentSync, documentId, content, provenance } = input;
  const collabOrigin = provenance ? provenanceToWriteOrigin(provenance) : null;

  if (collabOrigin) {
    try {
      const result = await documentSync.writeDocument({
        documentId,
        markdown: content,
        origin: collabOrigin,
        threadId: threadIdFromProvenance(provenance),
      });
      return { ok: true, markdown: result.markdown, updateSeq: result.updateSeq };
    } catch (error) {
      return { ok: false, error: thrownFault(error) };
    }
  }

  const write = await documentSync.writeFromMarkdown(
    documentId,
    content,
    provenanceToUpdateOrigin(provenance),
  );
  if (!write.ok) return { ok: false, error: syncFault(write.error) };

  const readBack = await documentSync.readAsMarkdown(documentId);
  if (!readBack.ok) return { ok: false, error: syncFault(readBack.error) };
  return { ok: true, markdown: readBack.value, updateSeq: write.value?.updateSeq };
}

export async function editCollabMarkdown(input: {
  documentSync: ContextCollabDomain;
  documentId: string;
  transform: (markdown: string) => string;
  provenance?: WriteProvenance;
}): Promise<CollabMarkdownResult> {
  const { documentSync, documentId, transform, provenance } = input;
  const collabOrigin = provenance ? provenanceToWriteOrigin(provenance) : null;

  if (collabOrigin) {
    try {
      const result = await documentSync.editDocument({
        documentId,
        transform,
        origin: collabOrigin,
        threadId: threadIdFromProvenance(provenance),
      });
      return { ok: true, markdown: result.markdown, updateSeq: result.updateSeq };
    } catch (error) {
      return { ok: false, error: thrownFault(error) };
    }
  }

  const before = await documentSync.readAsMarkdown(documentId);
  if (!before.ok) return { ok: false, error: syncFault(before.error) };

  const write = await documentSync.writeFromMarkdown(
    documentId,
    transform(before.value),
    provenanceToUpdateOrigin(provenance),
  );
  if (!write.ok) return { ok: false, error: syncFault(write.error) };

  const after = await documentSync.readAsMarkdown(documentId);
  if (!after.ok) return { ok: false, error: syncFault(after.error) };
  return { ok: true, markdown: after.value, updateSeq: write.value?.updateSeq };
}
