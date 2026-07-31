/** Import thread attachments into the thread's primary Work uploads:// source. */

import {
  classifyFiletype,
  documentFileTypeFor,
  type Filetype,
  filetypeForKnownMimeType,
  filetypeForKnownPath,
  filetypeForPath,
  type ThreadUploadDocumentItem,
} from "@meridian/contracts/protocol";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { type ObjectStorePort, objectStoreKeyFromStorageUrl } from "../../storage/index.js";
import type { ThreadRepositories } from "../../threads/index.js";
import { renderFilename } from "../context/paths.js";
import { toCanonical } from "../context/uri.js";
import { contextPortForThread, resolveThreadContext } from "../context-port-resolution.js";
import type { ContextPort } from "../ports/context-port.js";
import type { UnifiedContextPortFactory } from "../unified-context-port-factory.js";
import type { ThreadUploadDocumentStore } from "./thread-upload-documents.js";

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
  | "collab_error"
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
  contextPorts: UnifiedContextPortFactory;
  uploadDocuments: ThreadUploadDocumentStore;
  objectStore: ObjectStorePort;
  generateId?: () => string;
  eventSink: EventSink;
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

/** The original name wins; occupied names advance deterministically to name-2.ext, name-3.ext, … */
export function uploadFilenameCandidate(filename: string, ordinal: number): string {
  if (ordinal <= 1) return filename;
  const { name, extension } = splitFilename(filename);
  return renderFilename(`${name}-${ordinal}`, extension);
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
    if (pathFiletype && classifyFiletype(pathFiletype).kind === "tracked")
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

async function deleteDocumentBestEffort(
  deps: Pick<ThreadUploadImportServiceDeps, "eventSink">,
  port: ContextPort,
  uri: string,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    const deleted = await port.delete(uri, { origin: { type: "system" } });
    if (!deleted.ok)
      emitEvent(deps.eventSink, {
        level: "warn",
        source: "lib.thread-upload-import",
        name: "document_cleanup.failed",
        payload: { uri, error: deleted.error, ...context },
      });
  } catch (error) {
    emitEvent(deps.eventSink, {
      level: "warn",
      source: "lib.thread-upload-import",
      name: "document_cleanup.threw",
      payload: { uri, ...unknownToEventPayload(error), ...context },
    });
  }
}

export function createThreadUploadImportService(
  deps: ThreadUploadImportServiceDeps,
): ThreadUploadImportService {
  const generateId = deps.generateId ?? (() => crypto.randomUUID());
  return {
    async importUpload(input): Promise<ThreadUploadImportResult> {
      const resolution = await resolveThreadContext(
        { threads: deps.repos.threads, threadWorks: deps.repos.threadWorks },
        input.threadId,
      );
      if (!resolution || resolution.thread.projectId !== input.projectId) {
        return err("repository_error", "Thread upload target was not found");
      }
      if (!resolution.primaryWorkId) {
        return err("repository_error", "Thread has no primary Work for uploads");
      }

      const { extension } = splitFilename(input.filename);
      const { filetype } = uploadClassification({
        filename: input.filename,
        extension,
        mimeType: input.mimeType,
        bytes: input.bytes,
      });
      const editable = filetype !== null && classifyFiletype(filetype).kind === "tracked";
      const markdownProjection = editable ? Buffer.from(input.bytes).toString("utf8") : "";
      const port = contextPortForThread(deps.contextPorts, resolution);
      let storageUrl: string | null = null;
      let imported = false;
      if (!editable) {
        const put = await deps.objectStore.put(
          `uploads/${input.projectId}/${resolution.primaryWorkId}/${generateId()}/${extension || "file"}`,
          input.bytes,
          input.mimeType || "application/octet-stream",
        );
        if (!put.ok) return err("object_store_error", put.error.message);
        storageUrl = put.value.storageUrl;
      }

      let createdUri: string | null = null;
      let documentId: string | null = null;
      try {
        for (let ordinal = 1; ordinal < Number.MAX_SAFE_INTEGER; ordinal += 1) {
          const candidate = uploadFilenameCandidate(input.filename, ordinal);
          const uri = toCanonical("uploads", candidate, resolution.primaryWorkId);
          const existing = await port.stat(uri);
          if (existing.ok) continue;
          if (existing.error.code !== "not_found") {
            return err("repository_error", `Failed to inspect upload path: ${existing.error.code}`);
          }

          const origin = {
            type: "import" as const,
            userId: resolution.thread.userId,
            source: "thread_upload",
            filename: input.filename,
            sourceId: input.threadId,
          };
          const created = editable
            ? await port.createTrackedDocument(uri, markdownProjection, { origin })
            : await port.writeBinary(uri, {
                fileType: documentFileTypeFor({ filetype, mimeType: input.mimeType }) ?? "binary",
                storageUrl: storageUrl ?? "",
                mimeType: input.mimeType,
                sizeBytes: input.bytes.byteLength,
                origin,
              });
          if (!created.ok && created.error.code === "conflict") continue;
          if (!created.ok) {
            return err(
              editable && created.error.code === "io_error" ? "collab_error" : "repository_error",
              `Failed to create upload document: ${created.error.code}`,
            );
          }
          if (!created.value.documentId) {
            return err("repository_error", "Upload document creation returned no document ID");
          }
          createdUri = uri;
          documentId = created.value.documentId;
          break;
        }

        if (!createdUri || !documentId) {
          return err("repository_error", "No available upload filename could be allocated");
        }
        await deps.repos.threadDocuments.attach(input.threadId, documentId, "editing");
        const upload = await deps.uploadDocuments.getUpload(input.threadId, documentId);
        if (!upload) throw new Error("Upload document was not attached");
        imported = true;
        return ok(upload);
      } catch (error) {
        if (createdUri) {
          await deleteDocumentBestEffort(deps, port, createdUri, {
            documentId,
            threadId: input.threadId,
          });
        }
        if (documentId) {
          await deps.repos.threadDocuments
            .detach(input.threadId, documentId)
            .catch(() => undefined);
        }
        return err("repository_error", errorMessage(error, "Failed to import upload"));
      } finally {
        if (!imported) {
          await deleteObjectBestEffort(deps.eventSink, deps.objectStore, storageUrl, {
            documentId,
            threadId: input.threadId,
          });
        }
      }
    },
  };
}
