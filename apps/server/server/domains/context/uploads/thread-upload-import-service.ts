import {
  documentFileTypeFor,
  type Filetype,
  filetypeForKnownMimeType,
  filetypeForKnownPath,
  filetypeForPath,
  schemaTypeForFiletype,
  type ThreadUploadDocumentItem,
} from "@meridian/contracts/protocol";
import type { DocumentSyncPort } from "../../collab/index.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { type ObjectStorePort, objectStoreKeyFromStorageUrl } from "../../storage/index.js";
import type { ThreadRepositories } from "../../threads/index.js";
import {
  markdownForTrackedUpload,
  type ThreadUploadDocumentStore,
} from "./thread-upload-documents.js";

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/markdown",
  "application/toml",
  "application/x-yaml",
  "application/yaml",
  "application/xml",
  "text/markdown",
]);
const TEXT_MIME_SUFFIXES = ["+json", "+xml", "+yaml", "+yml"];

export type ThreadUploadImportErrorCode =
  | "object_store_error"
  | "mirror_error"
  | "repository_error";
export interface ThreadUploadImportError {
  code: ThreadUploadImportErrorCode;
  message: string;
}
export type ThreadUploadImportResult =
  | { ok: true; value: ThreadUploadDocumentItem }
  | { ok: false; error: ThreadUploadImportError };
export interface ThreadUploadImportInput {
  projectId: string;
  threadId: string;
  filename: string;
  bytes: Uint8Array;
  mimeType: string;
}
export interface ThreadUploadImportService {
  importUpload(input: ThreadUploadImportInput): Promise<ThreadUploadImportResult>;
}
export interface ThreadUploadImportServiceDeps {
  repos: ThreadRepositories;
  uploadDocuments: ThreadUploadDocumentStore;
  documentSync: DocumentSyncPort;
  objectStore: ObjectStorePort;
  generateId?: () => string;
  eventSink: EventSink;
}

class UploadImportFailure extends Error {
  constructor(
    readonly code: ThreadUploadImportErrorCode,
    message: string,
  ) {
    super(message);
  }
}
const ok = (value: ThreadUploadDocumentItem): ThreadUploadImportResult => ({ ok: true, value });
const err = (code: ThreadUploadImportErrorCode, message: string): ThreadUploadImportResult => ({
  ok: false,
  error: { code, message },
});
const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

function splitFilename(filename: string): { name: string; extension: string } {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return { name: filename, extension: "" };
  return { name: filename.slice(0, dot), extension: filename.slice(dot + 1).toLowerCase() };
}
function isKnownTextMimeType(mimeType: string): boolean {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!normalized) return false;
  if (normalized.startsWith("text/")) return true;
  return (
    TEXT_MIME_TYPES.has(normalized) ||
    TEXT_MIME_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}
const bytesContainNul = (bytes: Uint8Array) => bytes.includes(0);
const filetypeForTextUpload = (filename: string, extension: string): Filetype =>
  extension ? filetypeForPath(filename) : "text";
function uploadClassification(input: {
  filename: string;
  extension: string;
  mimeType: string;
  bytes: Uint8Array;
}): { filetype: Filetype | null } {
  const normalizedMime = input.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const mimeFiletype = normalizedMime ? filetypeForKnownMimeType(normalizedMime) : null;
  if (isKnownTextMimeType(normalizedMime))
    return { filetype: filetypeForTextUpload(input.filename, input.extension) };
  if (!normalizedMime && !bytesContainNul(input.bytes)) {
    const pathFiletype = input.extension ? filetypeForKnownPath(input.filename) : "text";
    if (pathFiletype && schemaTypeForFiletype(pathFiletype) !== null)
      return { filetype: pathFiletype };
  }
  if (documentFileTypeFor({ filetype: mimeFiletype, mimeType: normalizedMime }) !== null)
    return { filetype: null };
  return { filetype: null };
}
async function deleteObjectBestEffort(
  eventSink: EventSink,
  objectStore: ObjectStorePort,
  storageUrl: string | null,
  context: Record<string, unknown>,
): Promise<void> {
  const key = storageUrl ? objectStoreKeyFromStorageUrl(storageUrl) : null;
  if (!key) return;
  try {
    const deleted = await objectStore.delete(key);
    if (!deleted.ok)
      emitEvent(eventSink, {
        level: "warn",
        source: "lib.thread-upload-import",
        name: "object_cleanup.failed",
        payload: { key, error: deleted.error, ...context },
      });
  } catch (error) {
    emitEvent(eventSink, {
      level: "warn",
      source: "lib.thread-upload-import",
      name: "object_cleanup.threw",
      payload: { key, ...unknownToEventPayload(error), ...context },
    });
  }
}

export function createThreadUploadImportService(
  deps: ThreadUploadImportServiceDeps,
): ThreadUploadImportService {
  const generateId = deps.generateId ?? (() => crypto.randomUUID());
  return {
    async importUpload(input): Promise<ThreadUploadImportResult> {
      const { name, extension } = splitFilename(input.filename);
      const { filetype } = uploadClassification({
        filename: input.filename,
        extension,
        mimeType: input.mimeType,
        bytes: input.bytes,
      });
      const editable = filetype !== null && schemaTypeForFiletype(filetype) !== null;
      const documentId = generateId();
      let markdownProjection = "";
      let storageUrl: string | null = null;
      if (editable) {
        markdownProjection = markdownForTrackedUpload(
          extension,
          Buffer.from(input.bytes).toString("utf8"),
        );
      } else {
        const put = await deps.objectStore.put(
          `uploads/${input.projectId}/${input.threadId}/${documentId}/${extension || "file"}`,
          input.bytes,
          input.mimeType || "application/octet-stream",
        );
        if (!put.ok) return err("object_store_error", put.error.message);
        storageUrl = put.value.storageUrl;
      }
      try {
        return await deps.uploadDocuments.transaction(async () =>
          deps.repos.transaction(async () => {
            await deps.uploadDocuments.createUploadDocument({
              id: documentId,
              projectId: input.projectId,
              threadId: input.threadId,
              filename: input.filename,
              name,
              extension,
              filetype,
              mimeType: input.mimeType,
              sizeBytes: input.bytes.byteLength,
              markdownProjection,
              storageUrl,
            });
            if (editable) {
              const mirror = await deps.documentSync.getOrCreateMirror(
                documentId,
                markdownProjection,
                filetype,
              );
              if (!mirror.ok)
                throw new UploadImportFailure(
                  "mirror_error",
                  errorMessage(mirror.error, "Failed to seed upload mirror"),
                );
              const read = await deps.documentSync.readAsMarkdown(documentId);
              if (!read.ok)
                throw new UploadImportFailure(
                  "mirror_error",
                  errorMessage(read.error, "Failed to read upload mirror"),
                );
              await deps.uploadDocuments.updateMarkdownProjection(documentId, read.value);
            }
            await deps.repos.threadDocuments.attach(input.threadId, documentId, "editing");
            const upload = await deps.uploadDocuments.getUpload(input.threadId, documentId);
            if (!upload)
              throw new UploadImportFailure("repository_error", "Upload document was not attached");
            return ok(upload);
          }),
        );
      } catch (error) {
        if (editable && deps.documentSync.forgetMirror) deps.documentSync.forgetMirror(documentId);
        await deleteObjectBestEffort(deps.eventSink, deps.objectStore, storageUrl, {
          documentId,
          threadId: input.threadId,
        });
        if (error instanceof UploadImportFailure) return err(error.code, error.message);
        return err("repository_error", errorMessage(error, "Failed to import upload"));
      }
    },
  };
}
