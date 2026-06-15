/**
 * figures-api — HTTP client for figure asset upload and signed-URL retrieval.
 *
 * Wraps the project/document figure endpoints, seeds and reads a signed-URL
 * cache, and computes refresh timing. Owns the figure network surface; consumed
 * by the editor's figure node view and upload flow.
 */
import {
  deserializeTransport,
  type GetFigureSignedUrlResponse,
  type UploadFigureAssetResponse,
} from "@meridian/contracts/protocol";

import { signedUrlRefreshDelayMs } from "@/core/editor/figure-workflow";

import { errorMessageFromPayload, readResponsePayload } from "./http-client";

type FigureRouteInput = {
  projectId: string;
  documentId: string;
};

export type UploadFigureInput = FigureRouteInput & {
  file: File;
  alt?: string | null;
  label?: string | null;
  caption?: string | null;
  onProgress?: (progress: { loaded: number; total: number | null; percent: number | null }) => void;
};

export type GetFigureSignedUrlInput = FigureRouteInput & {
  src?: string;
  skipCache?: boolean;
};

type CachedSignedUrl = {
  projectId: string;
  routeDocumentId: string;
  responseDocumentId: string;
  storageUrl: string;
  signedUrl: string;
  signedUrlExpiresAt: string;
};

const signedUrlCache = new Map<string, CachedSignedUrl>();

function figurePath({ projectId, documentId }: FigureRouteInput): string {
  return `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(
    documentId,
  )}/figure`;
}

function signedUrlPath(input: FigureRouteInput): string {
  return `${figurePath(input)}/signed-url`;
}

function cacheKey(input: FigureRouteInput & { storageUrl: string }): string {
  return `${input.projectId}\u0000${input.documentId}\u0000${input.storageUrl}`;
}

function cacheSignedUrl(input: FigureRouteInput & GetFigureSignedUrlResponse): void {
  signedUrlCache.set(
    cacheKey({
      projectId: input.projectId,
      documentId: input.documentId,
      storageUrl: input.storageUrl,
    }),
    {
      projectId: input.projectId,
      routeDocumentId: input.documentId,
      responseDocumentId: input.documentId,
      storageUrl: input.storageUrl,
      signedUrl: input.signedUrl,
      signedUrlExpiresAt: input.signedUrlExpiresAt,
    },
  );
}

function getCachedSignedUrl(input: GetFigureSignedUrlInput): CachedSignedUrl | null {
  if (!input.src) return null;
  const cached = signedUrlCache.get(
    cacheKey({
      projectId: input.projectId,
      documentId: input.documentId,
      storageUrl: input.src,
    }),
  );
  if (!cached) return null;
  return signedUrlRefreshDelayMs(cached.signedUrlExpiresAt) > 0 ? cached : null;
}

export function seedFigureSignedUrlCache(
  input: FigureRouteInput & { reference: UploadFigureAssetResponse },
): void {
  cacheSignedUrl({
    projectId: input.projectId,
    documentId: input.documentId,
    storageUrl: input.reference.storageUrl,
    mimeType: input.reference.mimeType,
    fileType: input.reference.fileType,
    signedUrl: input.reference.signedUrl,
    signedUrlExpiresAt: input.reference.signedUrlExpiresAt,
  });
}

export async function getFigureSignedUrl(
  input: GetFigureSignedUrlInput,
): Promise<GetFigureSignedUrlResponse> {
  const cached = input.skipCache ? null : getCachedSignedUrl(input);
  if (cached) {
    return {
      documentId: cached.responseDocumentId,
      storageUrl: cached.storageUrl,
      mimeType: "image/*",
      fileType: "image",
      signedUrl: cached.signedUrl,
      signedUrlExpiresAt: cached.signedUrlExpiresAt,
    };
  }

  const response = await fetch(signedUrlPath(input), { method: "GET" });
  const payload = await readResponsePayload(response);
  if (!response.ok) throw new Error(errorMessageFromPayload(payload, response.status));

  const value = deserializeTransport<GetFigureSignedUrlResponse>(
    payload as GetFigureSignedUrlResponse,
  );
  if (input.src && value.storageUrl !== input.src) {
    throw new Error("The signed figure URL no longer matches this figure reference.");
  }
  cacheSignedUrl({ ...input, ...value });
  return value;
}

function appendOptionalText(form: FormData, name: string, value: string | null | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) form.append(name, trimmed);
}

function parseXhrPayload(xhr: XMLHttpRequest): unknown {
  if (!xhr.responseText) return null;
  try {
    return JSON.parse(xhr.responseText) as unknown;
  } catch {
    return xhr.responseText;
  }
}

export function uploadFigure(input: UploadFigureInput): Promise<UploadFigureAssetResponse> {
  const form = new FormData();
  form.append("file", input.file);
  appendOptionalText(form, "alt", input.alt);
  appendOptionalText(form, "label", input.label);
  appendOptionalText(form, "caption", input.caption);

  // XMLHttpRequest instead of fetch: the Fetch API has no upload-progress
  // event, so there's no way to report bytes-sent to the caller without
  // falling back to XHR. This is a known web-platform limitation.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", figurePath(input));

    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : null;
      input.onProgress?.({
        loaded: event.loaded,
        total,
        percent: total && total > 0 ? Math.round((event.loaded / total) * 100) : null,
      });
    };

    xhr.onerror = () =>
      reject(new Error("Figure upload failed. Check your connection and try again."));
    xhr.onabort = () => reject(new Error("Figure upload was cancelled."));
    xhr.onload = () => {
      const payload = parseXhrPayload(xhr);
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(errorMessageFromPayload(payload, xhr.status)));
        return;
      }

      const reference = deserializeTransport<UploadFigureAssetResponse>(
        payload as UploadFigureAssetResponse,
      );
      seedFigureSignedUrlCache({
        projectId: input.projectId,
        documentId: input.documentId,
        reference,
      });
      resolve(reference);
    };

    xhr.send(form);
  });
}
