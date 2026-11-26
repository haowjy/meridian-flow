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
