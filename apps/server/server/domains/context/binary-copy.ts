/**
 * Whole-document copy of a binary file (D24): the one place a copy depends on
 * how a document is stored. It duplicates the storage object, so deleting
 * either file never removes the other's bytes, and creates the destination
 * with `metadata.copiedFrom` through the copier's own port: in a draft-mode chat
 * that is a hidden row holding the branch's object, never shared (12b-Q2).
 * Tracked documents copy through agent-edit instead.
 *
 * Copying is two steps so a copy command can put every object before it writes any row:
 * `prepareBinaryCopy` duplicates the bytes, and `copyBinaryDocument` prepares and then
 * creates the destination in one go for callers with nothing to join.
 */

import {
  filenameForBinary,
  parseDocumentFilename,
  renderFilename,
} from "@meridian/contracts/protocol";
import { Err, type Result } from "../../shared/result.js";
import type { FileGrant } from "../file-policy/index.js";
import {
  type ObjectStorePort,
  objectStoreKeyFromStorageUrl,
  previewObjectKey,
} from "../storage/index.js";
import type { CopiedFrom } from "./document-metadata.js";
import type {
  BinaryFileRef,
  ContextBinaryWriteResult,
  ContextError,
  ContextPort,
  WriteProvenance,
} from "./ports/context-port.js";

/** A duplicated destination object, unreferenced until the row that names it commits. */
export interface PreparedBinaryCopy {
  /** The `object://` URL the destination row stores. */
  storageUrl: string;
  /** The put object's key, for releasing it if no row commits. */
  key: string;
  mimeType: string;
  sizeBytes: number;
  /** The destination has its own copy of the source's preview. */
  hasPreview: boolean;
}

/** Duplicate a binary's stored bytes for a destination that does not exist yet (D24). */
export async function prepareBinaryCopy(input: {
  objectStore: ObjectStorePort;
  source: Pick<BinaryFileRef, "uri" | "storageUrl" | "mimeType" | "hasPreview">;
}): Promise<Result<PreparedBinaryCopy, ContextError>> {
  const sourceKey = objectStoreKeyFromStorageUrl(input.source.storageUrl);
  if (!sourceKey) return ioError(input.source.uri, "The source file has no stored object.");
  const object = await input.objectStore.get(sourceKey);
  if (!object.ok) return ioError(input.source.uri, object.error.message);

  const key = `copies/${crypto.randomUUID()}`;
  const mimeType = input.source.mimeType ?? object.value.mimeType;
  const put = await input.objectStore.put(key, object.value.bytes, mimeType);
  if (!put.ok) return ioError(input.source.uri, put.error.message);
  // The preview is derived, so a copy that can't carry it just shows the file card.
  const preview = input.source.hasPreview
    ? await input.objectStore.get(previewObjectKey(sourceKey))
    : null;
  const hasPreview =
    preview?.ok === true &&
    (
      await input.objectStore.put(
        previewObjectKey(key),
        preview.value.bytes,
        preview.value.mimeType,
      )
    ).ok;
  return {
    ok: true,
    value: {
      storageUrl: put.value.storageUrl,
      key,
      mimeType,
      sizeBytes: object.value.bytes.byteLength,
      hasPreview,
    },
  };
}

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

  const prepared = await prepareBinaryCopy({
    objectStore: input.objectStore,
    source: input.source,
  });
  if (!prepared.ok) return prepared;

  const written = await input.port.writeBinary(destinationUri, {
    fileType: input.source.fileType,
    storageUrl: prepared.value.storageUrl,
    mimeType: prepared.value.mimeType,
    sizeBytes: prepared.value.sizeBytes,
    hasPreview: prepared.value.hasPreview,
    metadata: { copiedFrom: input.copiedFrom },
    ...(input.origin ? { origin: input.origin } : {}),
  });
  if (!written.ok) await input.objectStore.delete(prepared.value.key);
  return written;
}

function ioError(uri: string, message: string): Result<never, ContextError> {
  return Err({ code: "io_error", uri, message });
}
