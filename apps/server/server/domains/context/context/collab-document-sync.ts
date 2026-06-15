/**
 * Collab-aware document sync helpers for ContextFS: routes agent/human writes
 * through the DocumentSync facade (validateAgentTurn, touch activity, corrupt-
 * mirror recovery) while system/import writes stay on the inner sync port.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { DocumentSyncFacade, DocumentWriteOrigin } from "../../collab/index.js";
import type { DocumentSyncPort, SyncError } from "../../collab/ports/document-sync.js";
import type { AdapterFault } from "../ports/context-adapter.js";
import type { WriteProvenance } from "../ports/context-port.js";

export type ContextCollabDocumentSync = DocumentSyncPort &
  Partial<Pick<DocumentSyncFacade, "writeDocument" | "initializeMirror">>;

function syncFault(error: SyncError): AdapterFault {
  switch (error.code) {
    case "not_found":
      return {
        code: "io_error",
        message: `Yjs mirror not found for document: ${error.documentId}`,
      };
    case "checkpoint_not_found":
      return { code: "io_error", message: `Yjs checkpoint not found: ${error.checkpointId}` };
    case "corrupt_state":
      return { code: "io_error", message: error.message };
    case "edit_not_found":
      return { code: "io_error", message: `Edit text not found: ${error.oldText}` };
    case "ambiguous_edit":
      return {
        code: "io_error",
        message: `Edit text is ambiguous (${error.matchCount} matches): ${error.oldText}`,
      };
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

function threadIdFromProvenance(provenance: WriteProvenance | undefined): ThreadId | undefined {
  if (provenance?.type === "agent") return provenance.threadId;
  return undefined;
}

export async function ensureCollabMirror(
  documentSync: ContextCollabDocumentSync,
  documentId: string,
  markdown: string,
  filetype: string,
): Promise<{ ok: true } | { ok: false; error: AdapterFault }> {
  if (documentSync.initializeMirror) {
    try {
      await documentSync.initializeMirror(documentId);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "io_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  const mirror = await documentSync.getOrCreateMirror(documentId, markdown, filetype);
  if (!mirror.ok) return { ok: false, error: syncFault(mirror.error) };
  return { ok: true };
}

export async function writeCollabMarkdown(input: {
  documentSync: ContextCollabDocumentSync;
  documentId: string;
  seedMarkdown: string;
  filetype: string;
  content: string;
  provenance?: WriteProvenance;
}): Promise<{ ok: true; markdown: string } | { ok: false; error: AdapterFault }> {
  const { documentSync, documentId, seedMarkdown, filetype, content, provenance } = input;
  const collabOrigin = provenance ? provenanceToWriteOrigin(provenance) : null;

  if (collabOrigin && documentSync.writeDocument) {
    try {
      const result = await documentSync.writeDocument({
        documentId,
        markdown: content,
        origin: collabOrigin,
        threadId: threadIdFromProvenance(provenance),
      });
      return { ok: true, markdown: result.markdown };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "io_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  const mirror = await ensureCollabMirror(documentSync, documentId, seedMarkdown, filetype);
  if (!mirror.ok) return mirror;

  const write = await documentSync.writeFromMarkdown(
    documentId,
    content,
    provenance
      ? provenance.type === "agent"
        ? { type: "agent", actorTurnId: provenance.turnId }
        : provenance.type === "human"
          ? { type: "user", userId: provenance.userId }
          : provenance.type === "import"
            ? {
                type: "import",
                userId: provenance.userId,
                source: provenance.source,
                filename: provenance.filename,
                sourceId: provenance.sourceId,
              }
            : { type: "system" }
      : { type: "system" },
  );
  if (!write.ok) return { ok: false, error: syncFault(write.error) };

  const readBack = await documentSync.readAsMarkdown(documentId);
  if (!readBack.ok) return { ok: false, error: syncFault(readBack.error) };
  return { ok: true, markdown: readBack.value };
}
