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

import { signedUrlRefreshDelayMs } from "@/core/editor/image-workflow";

import { errorMessageFromPayload, readResponsePayload } from "./http-client";

type AssetRouteInput = {
  projectId: string;
  assetDocumentId: string;
};

export type UploadFigureInput = {
  projectId: string;
  hostDocumentId: string;
  file: File;
  alt?: string | null;
  label?: string | null;
  caption?: string | null;
  onProgress?: (progress: { loaded: number; total: number | null; percent: number | null }) => void;
};

export type GetFigureSignedUrlInput = AssetRouteInput & {
  src?: string;
  skipCache?: boolean;
};

type CachedSignedUrl = {
  projectId: string;
  assetDocumentId: string;
  storageUrl: string;
  signedUrl: string;
  signedUrlExpiresAt: string;
};

const signedUrlCache = new Map<string, CachedSignedUrl>();
const inFlightSignedUrls = new Map<string, Promise<GetFigureSignedUrlResponse>>();

function figurePath(projectId: string, documentId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(
    documentId,
  )}/figure`;
}

function signedUrlPath(input: AssetRouteInput): string {
  return `${figurePath(input.projectId, input.assetDocumentId)}/signed-url`;
}

function cacheKey(input: AssetRouteInput): string {
  return `${input.projectId}\u0000${input.assetDocumentId}`;
}

function cacheSignedUrl(input: AssetRouteInput & GetFigureSignedUrlResponse): void {
  signedUrlCache.set(
    cacheKey({
      projectId: input.projectId,
      assetDocumentId: input.assetDocumentId,
    }),
    {
      projectId: input.projectId,
      assetDocumentId: input.assetDocumentId,
      storageUrl: input.storageUrl,
      signedUrl: input.signedUrl,
      signedUrlExpiresAt: input.signedUrlExpiresAt,
    },
  );
}

function getCachedSignedUrl(input: GetFigureSignedUrlInput): CachedSignedUrl | null {
  const cached = signedUrlCache.get(
    cacheKey({
      projectId: input.projectId,
      assetDocumentId: input.assetDocumentId,
    }),
  );
  if (!cached) return null;
  return signedUrlRefreshDelayMs(cached.signedUrlExpiresAt) > 0 ? cached : null;
}

export function seedFigureSignedUrlCache(input: {
  projectId: string;
  reference: UploadFigureAssetResponse;
}): void {
  cacheSignedUrl({
    projectId: input.projectId,
    assetDocumentId: input.reference.assetDocumentId,
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
      assetDocumentId: cached.assetDocumentId,
      storageUrl: cached.storageUrl,
      mimeType: "image/*",
      fileType: "image",
      signedUrl: cached.signedUrl,
      signedUrlExpiresAt: cached.signedUrlExpiresAt,
    };
  }

  const key = cacheKey(input);
  const pending = inFlightSignedUrls.get(key);
  if (pending) return pending;

  const request = (async () => {
    const response = await fetch(signedUrlPath(input), { method: "GET" });
    const payload = await readResponsePayload(response);
    if (!response.ok) throw new Error(errorMessageFromPayload(payload, response.status));

    const value = deserializeTransport<GetFigureSignedUrlResponse>(
      payload as GetFigureSignedUrlResponse,
    );
    cacheSignedUrl({ ...input, ...value });
    return value;
  })();
  inFlightSignedUrls.set(key, request);
  try {
    return await request;
  } finally {
    if (inFlightSignedUrls.get(key) === request) inFlightSignedUrls.delete(key);
  }
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
    xhr.open("POST", figurePath(input.projectId, input.hostDocumentId));

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
        reference,
      });
      resolve(reference);
    };

    xhr.send(form);
  });
}
