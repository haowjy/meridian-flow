import type { ThreadId } from "@meridian/contracts/runtime";
import { isRetryableTransactionError } from "../../../shared/drizzle-transaction.js";
import { DocumentSyncError } from "../../collab/domain/markdown-document.js";
import type {
  BoundWrite,
  DocumentSeedOrigin,
  DocumentWriteOrigin,
  MarkdownDocumentStore,
  SyncError,
} from "../../collab/index.js";
import type { AdapterFault } from "../ports/context-adapter.js";
import type { WriteProvenance } from "../ports/context-port.js";

export type CollabMarkdownResult =
  | { ok: true; markdown: string }
  | { ok: false; error: AdapterFault };

function syncFault(error: SyncError): AdapterFault {
  switch (error.code) {
    case "not_found":
      return {
        code: "io_error",
        message: `Document not found: ${error.documentId}`,
      };
    case "stale_document":
      return { code: "io_error", message: `Document changed under the write: ${error.documentId}` };
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
  if (provenance.type === "import") {
    return { type: "user", actorUserId: provenance.userId };
  }
  return null;
}

function provenanceToSeedOrigin(provenance: WriteProvenance | undefined): DocumentSeedOrigin {
  if (!provenance) return { type: "system" };
  if (provenance.type === "import") {
    return {
      type: "import",
      userId: provenance.userId,
      source: provenance.source,
      filename: provenance.filename,
      sourceId: provenance.sourceId,
    };
  }
  if (provenance.type === "system") return { type: "system" };
  throw new Error("Agent and human document writes must use the identity-preserving write seam");
}

function threadIdFromProvenance(provenance: WriteProvenance | undefined): ThreadId | undefined {
  if (provenance?.type === "agent" || provenance?.type === "human") {
    return provenance.threadId;
  }
  return undefined;
}

function thrownFault(error: unknown): AdapterFault {
  if (error instanceof DocumentSyncError && error.code === "stale_document") {
    return { code: "stale_target" };
  }
  return {
    code: "io_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function writeCollabMarkdown(input: {
  documentSync: MarkdownDocumentStore;
  documentId: string;
  content: BoundWrite;
  provenance?: WriteProvenance;
}): Promise<CollabMarkdownResult> {
  const { documentSync, documentId, content, provenance } = input;
  const collabOrigin = provenance ? provenanceToWriteOrigin(provenance) : null;

  if (collabOrigin) {
    try {
      const result = await documentSync.writeDocument({
        documentId,
        content,
        origin: collabOrigin,
        threadId: threadIdFromProvenance(provenance),
      });
      return { ok: true, markdown: result.markdown };
    } catch (error) {
      if (isRetryableTransactionError(error)) throw error;
      return { ok: false, error: thrownFault(error) };
    }
  }

  const write = await documentSync.seedFromMarkdown(
    documentId,
    content,
    provenanceToSeedOrigin(provenance),
  );
  if (!write.ok) return { ok: false, error: syncFault(write.error) };

  const readBack = await documentSync.readAsMarkdown(documentId);
  if (!readBack.ok) return { ok: false, error: syncFault(readBack.error) };
  return { ok: true, markdown: readBack.value };
}
