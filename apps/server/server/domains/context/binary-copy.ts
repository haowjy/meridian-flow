import { copiedFilename, readSegment, renderFilename } from "@meridian/contracts/protocol";
import { Err, type Result } from "../../shared/result.js";
import type { FileGrant } from "../file-policy/index.js";
import {
  derivedObjectKeys,
  type ObjectRelease,
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

export interface PreparedBinaryCopy {
  storageUrl: string;
  key: string;
  mimeType: string;
  sizeBytes: number;
  hasPreview: boolean;
}

export async function prepareBinaryCopy(input: {
  objectStore: ObjectStorePort;
  source: Pick<BinaryFileRef, "uri" | "hasPreview"> & {
    storageUrl: string | null;
    mimeType: string | null;
  };
}): Promise<Result<PreparedBinaryCopy, ContextError>> {
  if (!input.source.storageUrl || !input.source.mimeType) {
    return ioError(input.source.uri, "The source file has no stored object or MIME type.");
  }
  const sourceKey = objectStoreKeyFromStorageUrl(input.source.storageUrl);
  if (!sourceKey) return ioError(input.source.uri, "The source file has no stored object.");
  const key = `copies/${crypto.randomUUID()}`;
  const copy = await input.objectStore.copy(sourceKey, key);
  if (!copy.ok) return ioError(input.source.uri, copy.error.message);
  const sources = derivedObjectKeys(sourceKey);
  const copied = await Promise.all(
    derivedObjectKeys(key).map((to, index) => input.objectStore.copy(sources[index], to)),
  );
  const hasPreview =
    input.source.hasPreview === true && copied[sources.indexOf(previewObjectKey(sourceKey))].ok;
  return {
    ok: true,
    value: {
      storageUrl: copy.value.storageUrl,
      key,
      mimeType: input.source.mimeType,
      sizeBytes: copy.value.sizeBytes,
      hasPreview,
    },
  };
}

interface BinaryCopyInput {
  port: ContextPort;
  objectStore: ObjectStorePort;
  release: ObjectRelease;
  source: BinaryFileRef;
  sourceGrant: FileGrant<"read">;
  destinationUri: string;
  copiedFrom: CopiedFrom;
  origin?: WriteProvenance;
}

export async function copyBinaryDocument(
  input: BinaryCopyInput,
): Promise<Result<ContextBinaryWriteResult, ContextError>> {
  const granted = input.sourceGrant.facts.target;
  if (granted.kind === "container" || granted.documentId !== input.source.documentId) {
    throw new Error("A binary copy's grant must name its source document");
  }
  const slash = input.destinationUri.lastIndexOf("/");
  const copied = copiedFilename(readSegment(input.destinationUri.slice(slash + 1)).name, {
    extension: input.source.extension,
    editable: false,
  });
  if (!copied.ok) return Err({ ...copied.error, uri: input.destinationUri });
  const { name, extension } = copied.filename;
  const destinationUri = input.destinationUri.slice(0, slash + 1) + renderFilename(name, extension);

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
    filename: { name, extension },
    metadata: { copiedFrom: input.copiedFrom },
    ...(input.origin ? { origin: input.origin } : {}),
  });
  if (!written.ok) await input.release.keys([prepared.value.key]);
  return written;
}

function ioError(uri: string, message: string): Result<never, ContextError> {
  return Err({ code: "io_error", uri, message });
}
