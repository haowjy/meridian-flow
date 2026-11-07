/**
 * FigureAssetService: mints the signed read URLs a picture in a document draws from. Pictures
 * arrive by the same direct upload as every other dropped file (`context/uploads`).
 */
import type { GetFigureSignedUrlResponse } from "@meridian/contracts/protocol";
import { drawObjectKey, objectStoreKeyFromStorageUrl } from "../../storage/object-storage-url.js";
import type { ObjectStorePort, ObjectStoreResult } from "../../storage/ports/object-store.js";
import type {
  DocumentFileRecord,
  FigureDocumentRepository,
} from "../ports/figure-document-repository.js";

import type { TreeView } from "../tree/tree-view.js";

export type FigureAssetErrorCode =
  | "document_not_found"
  | "invalid_storage_url"
  | "object_store_error"
  | "repository_error";

export interface FigureAssetError {
  code: FigureAssetErrorCode;
  message: string;
}

export type FigureAssetResult<T> = { ok: true; value: T } | { ok: false; error: FigureAssetError };

export interface GetFigureSignedUrlInput {
  view?: TreeView;
  projectId: string;
  assetDocumentId: string;
}

export interface FigureAssetServiceOptions {
  objectStore: Pick<ObjectStorePort, "getSignedUrl">;
  documents: FigureDocumentRepository;
  signedUrlExpiresAt: () => string;
}

export interface FigureAssetService {
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

export function createFigureAssetService(options: FigureAssetServiceOptions): FigureAssetService {
  return {
    async getSignedFigureUrl(
      input: GetFigureSignedUrlInput,
    ): Promise<FigureAssetResult<GetFigureSignedUrlResponse>> {
      let record: DocumentFileRecord | null;
      try {
        record = await options.documents.findDocumentFileForProject(
          input.projectId,
          input.assetDocumentId,
          input.view,
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
      const drawKey = drawObjectKey({
        key,
        mimeType: record.mimeType,
        hasPreview: record.hasPreview,
      });
      let drawUrl: string | undefined;
      if (drawKey === key) drawUrl = signedUrl.value;
      else if (drawKey) {
        // Without its preview the picture shows as a file card: still a usable answer.
        const preview = await options.objectStore.getSignedUrl(drawKey);
        if (preview.ok) drawUrl = preview.value;
      }

      return ok({
        assetDocumentId: record.assetDocumentId,
        storageUrl: record.storageUrl,
        mimeType: record.mimeType,
        fileType: record.fileType,
        name: record.name,
        sizeBytes: record.sizeBytes,
        signedUrl: signedUrl.value,
        ...(drawUrl ? { drawUrl } : {}),
        signedUrlExpiresAt: options.signedUrlExpiresAt(),
      });
    },
  };
}
