/**
 * Whole-document copy of a binary file (D24): the one place a copy depends on
 * how a document is stored. It duplicates the storage object, so deleting
 * either file never removes the other's bytes, and creates the destination
 * with `metadata.copiedFrom`. Tracked documents copy through agent-edit instead.
 */

import { Err, type Result } from "../../shared/result.js";
import type { FileGrant } from "../file-policy/index.js";
import { type ObjectStorePort, objectStoreKeyFromStorageUrl } from "../storage/index.js";
import type { CopiedFrom } from "./document-metadata.js";
import type {
  BinaryFileRef,
  ContextError,
  ContextPort,
  ContextWriteResult,
  WriteProvenance,
} from "./ports/context-port.js";

export interface BinaryCopyInput {
  /** The copier's own view, where the destination path must be free. */
  port: ContextPort;
  /** Where the file is created. Binary copies are never drafted (D24). */
  livePort: ContextPort;
  objectStore: ObjectStorePort;
  source: BinaryFileRef;
  /** Proof the copier may read the source (file-access §2); a copy can't skip it. */
  sourceGrant: FileGrant<"read">;
  destinationUri: string;
  copiedFrom: CopiedFrom;
  origin?: WriteProvenance;
}

/** Copies a binary file to a destination that must not exist yet. */
export async function copyBinaryDocument(
  input: BinaryCopyInput,
): Promise<Result<ContextWriteResult, ContextError>> {
  const granted = input.sourceGrant.target;
  if (granted.kind === "container" || granted.documentId !== input.source.documentId) {
    throw new Error("A binary copy's grant must name its source document");
  }
  const existing = await input.port.stat(input.destinationUri);
  if (existing.ok) {
    return Err({
      code: "invalid_operation",
      uri: existing.value.uri,
      message: `File already exists: ${input.destinationUri}. A binary copy can't replace an existing file.`,
    });
  }
  if (existing.error.code !== "not_found") return existing;

  const sourceKey = objectStoreKeyFromStorageUrl(input.source.storageUrl);
  if (!sourceKey) return ioError(input.source.uri, "The source file has no stored object.");
  const object = await input.objectStore.get(sourceKey);
  if (!object.ok) return ioError(input.source.uri, object.error.message);

  const key = `copies/${crypto.randomUUID()}`;
  const mimeType = input.source.mimeType ?? object.value.mimeType;
  const put = await input.objectStore.put(key, object.value.bytes, mimeType);
  if (!put.ok) return ioError(input.destinationUri, put.error.message);

  const written = await input.livePort.writeBinary(input.destinationUri, {
    fileType: input.source.fileType,
    storageUrl: put.value.storageUrl,
    mimeType,
    sizeBytes: object.value.bytes.byteLength,
    metadata: { copiedFrom: input.copiedFrom },
    ...(input.origin ? { origin: input.origin } : {}),
  });
  if (!written.ok) await input.objectStore.delete(key);
  return written;
}

function ioError(uri: string, message: string): Result<never, ContextError> {
  return Err({ code: "io_error", uri, message });
}
