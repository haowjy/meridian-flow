/**
 * document-links-api — HTTP client for internal link resolution.
 *
 * One call: hand the server a wikilink name, a scheme URI, or a relative path
 * and get back the project document it addresses. `{ document: null }` is a
 * normal answer, not an error — it covers both "nothing matched" and "several
 * did", because an ambiguous name resolves to nothing rather than to a guess.
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
