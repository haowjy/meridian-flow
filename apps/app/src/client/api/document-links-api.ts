/**
 * document-links-api — HTTP client for stored-link resolution.
 *
 * One batched call: hand the server up to 200 links, each its ref (or null)
 * and its href, and get back one answer per link in request order. `missing`
 * and `gone` are normal answers, not errors.
 */

import type {
  ResolveDocumentLinksRequest,
  ResolveDocumentLinksResponse,
} from "@meridian/contracts";
import { apiProjectLinksResolvePath } from "@meridian/contracts/protocol";

import { postJson } from "./http-client";

export async function resolveDocumentLinks(
  projectId: string,
  body: ResolveDocumentLinksRequest,
  init?: { signal?: AbortSignal },
): Promise<ResolveDocumentLinksResponse> {
  return postJson<ResolveDocumentLinksResponse>(apiProjectLinksResolvePath(projectId), body, {
    signal: init?.signal,
  });
}
