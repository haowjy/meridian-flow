/**
 * document-links-api — HTTP client for internal link resolution.
 *
 * Asks the batched resolve route about one address and answers the document
 * there. `{ document: null }` is a normal answer, not an error: nothing is
 * there yet.
 */

import type {
  ResolveDocumentLinksRequest,
  ResolveDocumentLinksResponse,
} from "@meridian/contracts";
import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import {
  apiProjectLinksResolvePath,
  type DocumentLinkTarget,
  type ResolvedDocumentLink,
} from "@meridian/contracts/protocol";

import { postJson } from "./http-client";

export async function resolveDocumentLink(
  projectId: string,
  body: { workId?: string | null; target: DocumentLinkTarget },
  init?: { signal?: AbortSignal },
): Promise<{ document: ResolvedDocumentLink | null }> {
  const { target } = body;
  const request: ResolveDocumentLinksRequest = {
    workId: body.workId ?? null,
    // Any non-null base: previous-location fallback is chat's alone.
    baseUri: target.kind === "relative" ? target.baseUri : target.uri,
    links: [{ ref: null, href: target.kind === "relative" ? target.path : target.uri }],
  };
  const { answers } = await postJson<ResolveDocumentLinksResponse>(
    apiProjectLinksResolvePath(projectId),
    request,
    { signal: init?.signal },
  );
  const answer = answers[0];
  if (answer?.state !== "document") return { document: null };
  const { id, scheme, ...rest } = answer.document;
  return { document: { documentId: id, scheme: scheme as ContextUriScheme, ...rest } };
}
