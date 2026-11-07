/**
 * figures-api — HTTP client for a picture's signed read URLs.
 *
 * Reads a signed-URL cache and fetches a fresh URL when it has expired. Pictures arrive by the
 * direct upload in `source-upload-api.ts`; this is what draws them.
 */
import type { GetFigureSignedUrlResponse } from "@meridian/contracts/protocol";

import { signedUrlRefreshDelayMs } from "@/core/editor/images";

import { getJson } from "./http-client";

type AssetRouteInput = {
  projectId: string;
  assetDocumentId: string;
};

/**
 * The server route that saves a stored file under its own name. A store's signed URL can't be
 * relied on for that: browsers ignore `download=` on another origin.
 */
export function documentDownloadUrl(documentId: string): string {
  return `/api/documents/${encodeURIComponent(documentId)}/download`;
}

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
