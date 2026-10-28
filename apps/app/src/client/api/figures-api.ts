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

import { signedUrlRefreshDelayMs } from "@/core/editor/images";

import { errorMessageFromPayload, getJson } from "./http-client";

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
  /**
   * Stops the request. A writer who deletes a picture mid-upload has cancelled
   * it, and the bytes still going up would be paid for by their connection.
   */
  signal?: AbortSignal;
};

export type GetFigureSignedUrlInput = AssetRouteInput & {
  /**
   * The Work the viewer is in. A picture still in a Work's branch is readable
   * only through that Work, so the request names it.
   */
  workId?: string;
  src?: string;
  skipCache?: boolean;
};

const signedUrlCache = new Map<string, GetFigureSignedUrlResponse>();
const inFlightSignedUrls = new Map<string, Promise<GetFigureSignedUrlResponse>>();

function figurePath(projectId: string, documentId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(
    documentId,
  )}/figure`;
}

function signedUrlPath(input: AssetRouteInput): string {
  return `${figurePath(input.projectId, input.assetDocumentId)}/signed-url`;
}

function cacheKey(input: AssetRouteInput & { workId?: string }): string {
  return `${input.projectId}\u0000${input.assetDocumentId}\u0000${input.workId ?? ""}`;
}

function cacheSignedUrl(
  input: AssetRouteInput & { workId?: string },
  value: GetFigureSignedUrlResponse,
): void {
  signedUrlCache.set(cacheKey(input), value);
}

function getCachedSignedUrl(input: GetFigureSignedUrlInput): GetFigureSignedUrlResponse | null {
  const cached = signedUrlCache.get(
    cacheKey({
      projectId: input.projectId,
      assetDocumentId: input.assetDocumentId,
      workId: input.workId,
    }),
  );
  if (!cached) return null;
  return signedUrlRefreshDelayMs(cached.signedUrlExpiresAt) > 0 ? cached : null;
}

export function seedFigureSignedUrlCache(input: {
  projectId: string;
  reference: UploadFigureAssetResponse;
}): void {
  cacheSignedUrl(
    { projectId: input.projectId, assetDocumentId: input.reference.assetDocumentId },
    input.reference,
  );
}

export async function getFigureSignedUrl(
  input: GetFigureSignedUrlInput,
): Promise<GetFigureSignedUrlResponse> {
  const cached = input.skipCache ? null : getCachedSignedUrl(input);
  if (cached) return cached;

  const key = cacheKey(input);
  const pending = inFlightSignedUrls.get(key);
  if (pending) return pending;

  const request = (async () => {
    // A refusal keeps its status: a 404 is the route saying the document is
    // gone (or unreadable, which it does not tell apart), not a failure.
    const query = input.workId ? `?workId=${encodeURIComponent(input.workId)}` : "";
    const value = await getJson<GetFigureSignedUrlResponse>(`${signedUrlPath(input)}${query}`);
    cacheSignedUrl(input, value);
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

    if (input.signal) {
      if (input.signal.aborted) {
        reject(new DOMException("Figure upload was cancelled.", "AbortError"));
        return;
      }
      input.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

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
    xhr.onabort = () => reject(new DOMException("Figure upload was cancelled.", "AbortError"));
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
