/**
 * What a document row says about itself as a file: tracked (editable text) or binary (bytes in
 * object storage). One mapping serves `ContextFS.stat`, which finds the row by path, and the
 * read route, which finds it by id.
 */
import { classifyFiletype, type YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import { documentMetadataFacts } from "../../document-metadata.js";
import type { AdapterFault, AdapterFileRef } from "../../ports/context-adapter.js";
import type { ContextDocument } from "../../ports/context-document-store.js";
import type { VisibleDocument } from "../../tree/tree-view.js";
import { DEFAULT_EDITABLE_FILETYPE } from "./bound-writes.js";
import { mapDocument } from "./drizzle-store.js";

export function trackedSchemaForPersistedFiletype(
  filetype: string | null | undefined,
): Result<YjsTrackedSchemaType, AdapterFault> {
  const classification = classifyFiletype(filetype);
  if (classification.kind === "tracked") return Ok(classification.schemaType);
  if (classification.kind === "unknown") return Ok("document");
  return Err({
    code: "io_error",
    message: `Tracked document has registered ${classification.kind} filetype: ${filetype}`,
  });
}

/** `path` is the address the caller reached the row at, with its stored leaf. */
export function fileRefOf(
  doc: ContextDocument,
  path: string,
): Result<AdapterFileRef, AdapterFault> {
  const base = {
    path,
    documentId: doc.id,
    sizeBytes: doc.sizeBytes ?? undefined,
    updatedAt: doc.updatedAt,
    ...documentMetadataFacts(doc.metadata),
  };
  if (doc.fileType === null) {
    const filetype = doc.filetype ?? DEFAULT_EDITABLE_FILETYPE;
    const schemaType = trackedSchemaForPersistedFiletype(filetype);
    if (!schemaType.ok) return schemaType;
    return Ok({ ...base, kind: "tracked", filetype, schemaType: schemaType.value });
  }
  if (!doc.storageUrl) {
    return Err({ code: "io_error", message: "Binary document is missing object storage URL" });
  }
  return Ok({
    ...base,
    kind: "binary",
    fileType: doc.fileType,
    storageUrl: doc.storageUrl,
    mimeType: doc.mimeType ?? undefined,
    hasPreview: doc.hasPreview,
  });
}

/** A tree-reader row, the way the by-id read route holds one. */
export function fileRefOfVisible(row: VisibleDocument): Result<AdapterFileRef, AdapterFault> {
  return fileRefOf(mapDocument(row), row.path);
}
