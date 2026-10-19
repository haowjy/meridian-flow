/**
 * Whole-document copy of a binary file (D24): the one place a copy depends on
 * how a document is stored. It duplicates the storage object, so deleting
 * either file never removes the other's bytes, and creates the destination
 * with `metadata.copiedFrom` through the copier's own port: in a draft-mode chat
 * that is a hidden row holding the branch's object, never shared (12b-Q2).
 * Tracked documents copy through agent-edit instead.
 */

import {
  filenameForBinary,
  parseDocumentFilename,
  renderFilename,
} from "@meridian/contracts/protocol";
import { Err, Ok, type Result } from "../../shared/result.js";
import type { FileGrant } from "../file-policy/index.js";
import { type ObjectStorePort, objectStoreKeyFromStorageUrl } from "../storage/index.js";
import type { CopiedFrom } from "./document-metadata.js";
import type {
  BinaryFileRef,
  ContextBinaryWriteResult,
  ContextError,
  ContextPort,
  WriteProvenance,
} from "./ports/context-port.js";

interface BinaryCopyInput {
  /** The copier's own port: where the destination path must be free and the file is created. */
  port: ContextPort;
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
): Promise<Result<ContextBinaryWriteResult, ContextError>> {
  const granted = input.sourceGrant.facts.target;
  if (granted.kind === "container" || granted.documentId !== input.source.documentId) {
    throw new Error("A binary copy's grant must name its source document");
  }
  const sourceParts = parseDocumentFilename(
    input.source.uri.slice(input.source.uri.lastIndexOf("/") + 1),
  );
  if (!sourceParts.ok) return Err({ ...sourceParts.error, uri: input.source.uri });
  const slash = input.destinationUri.lastIndexOf("/");
  const destinationParts = parseDocumentFilename(input.destinationUri.slice(slash + 1), {
    sourceExtension: sourceParts.value.extension,
  });
  if (!destinationParts.ok) return Err({ ...destinationParts.error, uri: input.destinationUri });
  const parts = filenameForBinary(
    destinationParts.value,
    input.source.fileType,
    input.source.mimeType ?? undefined,
  );
  const destinationUri =
    input.destinationUri.slice(0, slash + 1) + renderFilename(parts.name, parts.extension);
  const existing = await input.port.stat(destinationUri);
  if (existing.ok) {
    return Err({
      code: "invalid_operation",
      uri: existing.value.uri,
      message: `File already exists: ${input.destinationUri}. A binary copy can't replace an existing file.`,
    });
  }
  if (existing.error.code !== "not_found") return existing;

  const prepared = await prepareBinaryCopy(input.objectStore, input.source);
  if (!prepared.ok) return prepared;
  const { key, storageUrl, mimeType, sizeBytes } = prepared.value;

  const written = await input.port.writeBinary(destinationUri, {
    fileType: input.source.fileType,
    storageUrl,
    mimeType,
    sizeBytes,
    metadata: { copiedFrom: input.copiedFrom },
    ...(input.origin ? { origin: input.origin } : {}),
  });
  if (!written.ok) await input.objectStore.delete(key);
  return written;
}

/** Prepare independent object bytes before a tree transaction; its caller owns failed-install cleanup. */
export async function prepareBinaryCopy(
  objectStore: ObjectStorePort,
  source: Pick<BinaryFileRef, "storageUrl" | "mimeType" | "uri">,
  signal?: AbortSignal,
  allocated?: (key: string) => void,
): Promise<
  Result<{ key: string; storageUrl: string; mimeType: string; sizeBytes: number }, ContextError>
> {
  const sourceKey = objectStoreKeyFromStorageUrl(source.storageUrl);
  if (!sourceKey) return ioError(source.uri, "The source file has no stored object.");
  signal?.throwIfAborted();
  const object = await objectStore.get(sourceKey, signal);
  if (!object.ok) return ioError(source.uri, object.error.message);
  const key = `copies/${crypto.randomUUID()}`;
  const mimeType = source.mimeType ?? object.value.mimeType;
  allocated?.(key);
  signal?.throwIfAborted();
  const put = await objectStore.put(key, object.value.bytes, mimeType, signal);
  if (!put.ok) return ioError(source.uri, put.error.message);
  return Ok({
    key,
    storageUrl: put.value.storageUrl,
    mimeType,
    sizeBytes: object.value.bytes.byteLength,
  });
}

function ioError(uri: string, message: string): Result<never, ContextError> {
  return Err({ code: "io_error", uri, message });
}
