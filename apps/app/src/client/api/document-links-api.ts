/**
 * document-links-api — HTTP client for internal link resolution.
 *
 * One call: hand the server a Context URI or a relative path and get back the
 * project document at that address. `{ document: null }` is a normal answer,
 * not an error: nothing is there yet.
 */

import {
  apiProjectLinksResolvePath,
  type ResolveDocumentLinkRequest,
  type ResolveDocumentLinkResponse,
} from "@meridian/contracts/protocol";

import { postJson } from "./http-client";

export async function resolveDocumentLink(
  projectId: string,
  body: ResolveDocumentLinkRequest,
  init?: { signal?: AbortSignal },
): Promise<ResolveDocumentLinkResponse> {
  return postJson<ResolveDocumentLinkResponse>(apiProjectLinksResolvePath(projectId), body, {
    signal: init?.signal,
  });
}
