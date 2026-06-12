import { randomUUID } from "node:crypto";
import type {
  FigureAssetReference,
  GetFigureSignedUrlResponse,
} from "@meridian/contracts/protocol";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { objectStoreKeyFromStorageUrl } from "../../storage/object-storage-url.js";
import type { ObjectStorePort } from "../../storage/ports/object-store.js";
import type {
  DocumentFileRecord,
  FigureDocumentRepository,
} from "../ports/figure-document-repository.js";
import { mapFigureFileType } from "./figure-file-types.js";

export type FigureAssetErrorCode =
  | "document_not_found"
  | "invalid_storage_url"
  | "unsupported_mime_type"
  | "object_store_error"
  | "repository_error";
export interface FigureAssetError {
  code: FigureAssetErrorCode;
  message: string;
}
export type FigureAssetResult<T> = { ok: true; value: T } | { ok: false; error: FigureAssetError };
export interface UploadFigureAssetInput {
  workbenchId: string;
  documentId: string;
  bytes: Uint8Array;
  mimeType: string;
  filename?: string | null;
  alt?: string | null;
  label?: string | null;
  caption?: string | null;
}
export interface GetFigureSignedUrlInput {
  workbenchId: string;
  documentId: string;
}
export interface FigureAssetServiceOptions {
  objectStore: ObjectStorePort;
  documents: FigureDocumentRepository;
  signedUrlExpiresAt: () => string;
  generateId?: () => string;
  eventSink: EventSink;
}
export interface FigureAssetService {
  uploadFigure(input: UploadFigureAssetInput): Promise<FigureAssetResult<FigureAssetReference>>;
  getSignedFigureUrl(
    input: GetFigureSignedUrlInput,
  ): Promise<FigureAssetResult<GetFigureSignedUrlResponse>>;
}

const ok = <T>(value: T): FigureAssetResult<T> => ({ ok: true, value });
const err = (code: FigureAssetErrorCode, message: string): FigureAssetResult<never> => ({
  ok: false,
  error: { code, message },
});
const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

async function deleteObjectBestEffort(
  eventSink: EventSink,
  objectStore: ObjectStorePort,
  key: string,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    const deleted = await objectStore.delete(key);
    if (!deleted.ok)
      emitEvent(eventSink, {
        level: "warn",
        source: "context.figures",
        name: "object_cleanup.failed",
        payload: { key, error: deleted.error, ...context },
      });
  } catch (error) {
    emitEvent(eventSink, {
      level: "warn",
      source: "context.figures",
      name: "object_cleanup.threw",
      payload: { key, ...unknownToEventPayload(error), ...context },
    });
  }
}
async function signObjectUrlBestEffort(
  eventSink: EventSink,
  objectStore: ObjectStorePort,
  key: string,
  context: Record<string, unknown>,
): Promise<string | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const signedUrl = await objectStore.getSignedUrl(key);
      if (signedUrl.ok) return signedUrl.value;
      emitEvent(eventSink, {
        level: "warn",
        source: "context.figures",
        name: "signed_url.failed",
        payload: { key, attempt, error: signedUrl.error, ...context },
      });
    } catch (error) {
      emitEvent(eventSink, {
        level: "warn",
        source: "context.figures",
        name: "signed_url.threw",
        payload: { key, attempt, ...unknownToEventPayload(error), ...context },
      });
    }
  }
  return null;
}
function extensionFor(mimeType: string, filename?: string | null): string {
  const filenameExtension = filename?.split(".").pop()?.toLowerCase();
  if (filenameExtension && /^[a-z0-9]{1,12}$/.test(filenameExtension)) return filenameExtension;
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    return "docx";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/svg+xml") return "svg";
  return mimeType.startsWith("image/")
    ? mimeType.slice("image/".length).replace(/[^a-z0-9]/g, "") || "img"
    : "bin";
}
function sanitizeKeyPart(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "asset"
  );
}
function createObjectKey(input: {
  workbenchId: string;
  documentId: string;
  filename?: string | null;
  mimeType: string;
  uniqueId: string;
}): string {
  const ext = extensionFor(input.mimeType, input.filename);
  const base = sanitizeKeyPart(input.filename?.replace(/\.[^.]+$/, "") ?? "figure");
  return `figures/${sanitizeKeyPart(input.workbenchId)}/${sanitizeKeyPart(input.documentId)}/${sanitizeKeyPart(input.uniqueId)}-${base}.${ext}`;
}
const labelFromDocumentId = (documentId: string) =>
  `fig-${sanitizeKeyPart(documentId).slice(0, 24)}`;
function toReference(input: {
  record: DocumentFileRecord;
  signedUrl: string;
  signedUrlExpiresAt: string;
  alt: string;
  label: string | null;
  caption: string | null;
}): FigureAssetReference {
  return {
    documentId: input.record.documentId,
    storageUrl: input.record.storageUrl,
    mimeType: input.record.mimeType,
    fileType: input.record.fileType,
    sizeBytes: input.record.sizeBytes,
    figure: {
      src: input.record.storageUrl,
      alt: input.alt,
      label: input.label,
      caption: input.caption,
    },
    signedUrl: input.signedUrl,
    signedUrlExpiresAt: input.signedUrlExpiresAt,
  };
}

export function createFigureAssetService(options: FigureAssetServiceOptions): FigureAssetService {
  const generateId = options.generateId ?? (() => randomUUID());
  return {
    async uploadFigure(input) {
      const fileType = mapFigureFileType(input.mimeType);
      if (!fileType)
        return err("unsupported_mime_type", `Unsupported figure MIME type: ${input.mimeType}`);
      let existing: DocumentFileRecord | null;
      try {
        existing = await options.documents.findDocumentFileForWorkbench(
          input.workbenchId,
          input.documentId,
        );
      } catch (error) {
        return err(
          "repository_error",
          errorMessage(error, "Failed to read existing document file"),
        );
      }
      if (existing) {
        const key = objectStoreKeyFromStorageUrl(existing.storageUrl);
        if (!key) return err("invalid_storage_url", "Figure storage URL is invalid");
        const signedUrl = await signObjectUrlBestEffort(
          options.eventSink,
          options.objectStore,
          key,
          { workbenchId: input.workbenchId, documentId: input.documentId },
        );
        if (!signedUrl) return err("object_store_error", "Failed to sign existing figure URL");
        return ok(
          toReference({
            record: existing,
            signedUrl,
            signedUrlExpiresAt: options.signedUrlExpiresAt(),
            alt: input.alt ?? "Figure",
            label: input.label ?? labelFromDocumentId(input.documentId),
            caption: input.caption ?? null,
          }),
        );
      }
      const key = createObjectKey({ ...input, uniqueId: generateId() });
      const stored = await options.objectStore.put(key, input.bytes, input.mimeType);
      if (!stored.ok) return err("object_store_error", stored.error.message);
      let record: DocumentFileRecord | null;
      try {
        record = await options.documents.attachDocumentFile({
          workbenchId: input.workbenchId,
          documentId: input.documentId,
          storageUrl: stored.value.storageUrl,
          mimeType: input.mimeType,
          fileType,
          sizeBytes: input.bytes.byteLength,
        });
      } catch (error) {
        await deleteObjectBestEffort(options.eventSink, options.objectStore, key, {
          workbenchId: input.workbenchId,
          documentId: input.documentId,
        });
        return err("repository_error", errorMessage(error, "Failed to attach figure file"));
      }
      if (!record) {
        await deleteObjectBestEffort(options.eventSink, options.objectStore, key, {
          workbenchId: input.workbenchId,
          documentId: input.documentId,
        });
        return err("document_not_found", "Document not found");
      }
      const signedUrl = await signObjectUrlBestEffort(options.eventSink, options.objectStore, key, {
        workbenchId: input.workbenchId,
        documentId: input.documentId,
      });
      if (!signedUrl) return err("object_store_error", "Failed to sign figure URL");
      return ok(
        toReference({
          record,
          signedUrl,
          signedUrlExpiresAt: options.signedUrlExpiresAt(),
          alt: input.alt ?? "Figure",
          label: input.label ?? labelFromDocumentId(input.documentId),
          caption: input.caption ?? null,
        }),
      );
    },
    async getSignedFigureUrl(input) {
      let record: DocumentFileRecord | null;
      try {
        record = await options.documents.findDocumentFileForWorkbench(
          input.workbenchId,
          input.documentId,
        );
      } catch (error) {
        return err("repository_error", errorMessage(error, "Failed to read figure file"));
      }
      if (!record) return err("document_not_found", "Document not found");
      const key = objectStoreKeyFromStorageUrl(record.storageUrl);
      if (!key) return err("invalid_storage_url", "Figure storage URL is invalid");
      const signedUrl = await signObjectUrlBestEffort(options.eventSink, options.objectStore, key, {
        workbenchId: input.workbenchId,
        documentId: input.documentId,
      });
      if (!signedUrl) return err("object_store_error", "Failed to sign figure URL");
      return ok({
        documentId: record.documentId,
        storageUrl: record.storageUrl,
        mimeType: record.mimeType,
        fileType: record.fileType,
        signedUrl,
        signedUrlExpiresAt: options.signedUrlExpiresAt(),
      });
    },
  };
}
