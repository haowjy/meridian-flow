/**
 * The port that answers where an internal link in this project goes.
 *
 * **An answer belongs to a scope, not to a href.** What `[[Notes]]` or
 * `./cast.md` points at is a function of the project, the active Work, the URI
 * of the document holding the link, and which documents the project holds. All
 * four are inputs here, the last as the catalog's own revision, and the store
 * treats a new registration as a generation: register again and every answer
 * the last one produced is unreachable. That is why a rename needs no line
 * anywhere that pokes a cache.
 *
 * Two surfaces ask. The manuscript asks about the links inside one document,
 * so it has a base URI and its relative hrefs mean something. The chat
 * transcript asks about the links inside a message, which is nowhere in the
 * project, so it has none — and `./cast.md` in a chat message is a question
 * that cannot be asked rather than a document that does not exist.
 */

import { useCallback, useMemo } from "react";

import { resolveDocumentLink } from "@/client/api/document-links-api";
import { documentLinkTarget, type InternalLinkResolver } from "@/core/links";

import { type ReferenceScope, useReferenceCandidates } from "./useReferenceCandidates";

export type ProjectLinkResolver = {
  /** Null while there is no project to ask about, which is a real state. */
  resolve: InternalLinkResolver | null;
  /**
   * Which catalog an answer would be about. Registering against a different
   * one is how an answer about the old catalog becomes unreachable.
   */
  revision: string;
};

export function useProjectLinkResolver(
  { projectId, workId }: ReferenceScope,
  /**
   * The document whose links these are, when the links live in one. The
   * transcript passes nothing: a message holds no relative links it could
   * answer.
   */
  baseDocumentId?: string | null,
): ProjectLinkResolver {
  const { candidates, revision } = useReferenceCandidates({ projectId, workId });

  // What this document's relative links are relative to, read out of the same
  // index the `[[` menu offers rows from: a scratch note the menu names is a
  // note that can hold `./cast.md` too. Null until the tree carrying it
  // arrives, which is a link with no answer yet rather than a missing document.
  const baseUri = useMemo(() => {
    if (!baseDocumentId) return null;
    for (const candidate of candidates) {
      if (candidate.kind === "document" && candidate.documentId === baseDocumentId)
        return candidate.uri;
    }
    return null;
  }, [candidates, baseDocumentId]);

  const resolve = useCallback<InternalLinkResolver>(
    async (target) => {
      if (!projectId) throw new Error("link resolution has no project");
      const request = documentLinkTarget(target, baseUri ?? "");
      // A relative path is meaningless without the URI of the document holding
      // it. Throwing rather than answering "nothing found" is deliberate: the
      // question could not be asked, and an unasked question must not render as
      // a missing document. The base arriving is a scope change, so this same
      // link is asked again instead of staying failed.
      if (!request) throw new Error("link target is not a document link");
      if (request.kind === "relative" && !baseUri) {
        throw new Error("relative link has no base document URI yet");
      }
      const { document } = await resolveDocumentLink(projectId, { workId, target: request });
      return document;
    },
    [baseUri, projectId, workId],
  );

  return { resolve: projectId ? resolve : null, revision };
}
