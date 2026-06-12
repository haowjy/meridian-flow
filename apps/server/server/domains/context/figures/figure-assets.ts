/**
 * FigureAssetService business logic: uploads binary figures to object storage,
 * attaches persisted document-file metadata, and mints signed read URLs.
 *
 * Why independent: Figure upload is two-phase (object write → repository attach)
 * and needs partial-failure cleanup without depending on repository adapters.
 */
import { randomUUID } from "node:crypto";
import type {
  FigureAssetReference,
  GetFigureSignedUrlResponse,
} from "@meridian/contracts/protocol";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { objectStoreKeyFromStorageUrl } from "../../storage/object-storage-url.js";
import type { ObjectStorePort, ObjectStoreResult } from "../../storage/ports/object-store.js";
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

function ok<T>(value: T): FigureAssetResult<T> {
  return { ok: true, value };
}

function err(code: FigureAssetErrorCode, message: string): FigureAssetResult<never> {
  return { ok: false, error: { code, message } };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function deleteObjectBestEffort(
  eventSink: EventSink,
  objectStore: ObjectStorePort,
  key: string,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    const deleted = await objectStore.delete(key);
    if (!deleted.ok) {
      emitEvent(eventSink, {
        level: "warn",
        source: "context.figures",
        name: "object_cleanup.failed",
        payload: { key, error: deleted.error, ...context },
      });
    }
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
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return "docx";
  }
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/svg+xml") return "svg";
  return mimeType.startsWith("image/")
    ? mimeType.slice("image/".length).replace(/[^a-z0-9]/g, "") || "img"
    : "bin";
}

function sanitizeKeyPart(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "asset";
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
  const workbench = sanitizeKeyPart(input.workbenchId);
  const document = sanitizeKeyPart(input.documentId);
  const id = sanitizeKeyPart(input.uniqueId);
  return `figures/${workbench}/${document}/${id}-${base}.${ext}`;
}

function labelFromDocumentId(documentId: string): string {
  return `fig-${sanitizeKeyPart(documentId).slice(0, 24)}`;
}

function toReference(input: {
  record: DocumentFileRecord;
  signedUrl: string;
  signedUrlExpiresAt: string;
  alt: string;
  label: string | null;
  caption: string | null;
}): FigureAssetReference {
  const figure = {
    src: input.record.storageUrl,
    alt: input.alt,
    label: input.label,
    caption: input.caption,
  };
  return {
    documentId: input.record.documentId,
    storageUrl: input.record.storageUrl,
    mimeType: input.record.mimeType,
    fileType: input.record.fileType,
    sizeBytes: input.record.sizeBytes,
    figure,
    signedUrl: input.signedUrl,
    signedUrlExpiresAt: input.signedUrlExpiresAt,
  };
}

export function createFigureAssetService(options: FigureAssetServiceOptions): FigureAssetService {
  const generateId = options.generateId ?? (() => randomUUID());
  const eventSink = options.eventSink;

  return {
    async uploadFigure(
      input: UploadFigureAssetInput,
    ): Promise<FigureAssetResult<FigureAssetReference>> {
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
      const key = createObjectKey({
        workbenchId: input.workbenchId,
        documentId: input.documentId,
        filename: input.filename,
        mimeType: input.mimeType,
        uniqueId: generateId(),
      });

      let put: ObjectStoreResult<{ storageUrl: string }>;
      try {
        put = await options.objectStore.put(key, input.bytes, input.mimeType);
      } catch (error) {
        return err("object_store_error", errorMessage(error, "Failed to write object"));
      }
      if (!put.ok) return err("object_store_error", put.error.message);

      let attached: DocumentFileRecord | null;
      try {
        attached = await options.documents.attachDocumentFile({
          workbenchId: input.workbenchId,
          documentId: input.documentId,
          storageUrl: put.value.storageUrl,
          mimeType: input.mimeType,
          fileType,
          sizeBytes: input.bytes.byteLength,
        });
      } catch (error) {
        await deleteObjectBestEffort(eventSink, options.objectStore, key, {
          workbenchId: input.workbenchId,
          documentId: input.documentId,
          phase: "attach_throw",
        });
        return err("repository_error", errorMessage(error, "Failed to attach document file"));
      }
      if (!attached) {
        await deleteObjectBestEffort(eventSink, options.objectStore, key, {
          workbenchId: input.workbenchId,
          documentId: input.documentId,
          phase: "document_missing",
        });
        return err("document_not_found", "Document not found");
      }

      if (existing?.storageUrl) {
        const oldKey = objectStoreKeyFromStorageUrl(existing.storageUrl);
        if (oldKey) {
          await deleteObjectBestEffort(eventSink, options.objectStore, oldKey, {
            workbenchId: input.workbenchId,
            documentId: input.documentId,
            phase: "old_object_replacement",
          });
        }
      }

      const signedUrl =
        (await signObjectUrlBestEffort(eventSink, options.objectStore, key, {
          workbenchId: input.workbenchId,
          documentId: input.documentId,
          phase: "upload_response",
        })) ?? "";

      const alt = input.alt?.trim() || input.filename || "Figure";
      const label = input.label?.trim() || labelFromDocumentId(input.documentId);
      const caption = input.caption?.trim() || null;
      const signedUrlExpiresAt = signedUrl
        ? options.signedUrlExpiresAt()
        : new Date(0).toISOString();
      return ok(
        toReference({
          record: attached,
          signedUrl,
          signedUrlExpiresAt,
          alt,
          label,
          caption,
        }),
      );
    },

    async getSignedFigureUrl(
      input: GetFigureSignedUrlInput,
    ): Promise<FigureAssetResult<GetFigureSignedUrlResponse>> {
      let record: DocumentFileRecord | null;
      try {
        record = await options.documents.findDocumentFileForWorkbench(
          input.workbenchId,
          input.documentId,
        );
      } catch (error) {
        return err("repository_error", errorMessage(error, "Failed to read document file"));
      }
      if (!record) return err("document_not_found", "Document file not found");

      const key = objectStoreKeyFromStorageUrl(record.storageUrl);
      if (!key) return err("invalid_storage_url", "Document storage URL is invalid");

      let signedUrl: ObjectStoreResult<string>;
      try {
        signedUrl = await options.objectStore.getSignedUrl(key);
      } catch (error) {
        return err("object_store_error", errorMessage(error, "Failed to sign object URL"));
      }
      if (!signedUrl.ok) return err("object_store_error", signedUrl.error.message);

      return ok({
        documentId: record.documentId,
        storageUrl: record.storageUrl,
        mimeType: record.mimeType,
        fileType: record.fileType,
        signedUrl: signedUrl.value,
        signedUrlExpiresAt: options.signedUrlExpiresAt(),
      });
    },
  };
}
