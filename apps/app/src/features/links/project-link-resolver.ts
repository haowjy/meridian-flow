/**
 * What the internal links of one resolution scope name: the local answer from
 * the scope's document index where it can give one, synchronously, then the
 * server for the rest, in batches.
 *
 * - A `doc:` ref the complete index holds resolves locally to that document,
 *   wherever it lives now.
 * - An `ahead:` ref always asks the server, because settlement is server
 *   state. Until it answers, a document the complete index holds at exactly
 *   the ref's stored address is the answer, shown at once (a Follow-Create,
 *   say, before the server has settled the ref). Only a server `document`
 *   naming another document, or `gone`, replaces it; with nothing there, the
 *   server's `missing` is "doesn't exist yet".
 * - A link with no ref resolves by its address: the local index first
 *   (`matchDocumentPath`, through `indexedDocumentAt`), then the server.
 *
 * The local index answers only when it is complete; an incomplete one cannot
 * prove which document is at an address, and a `doc:` ref it does not hold
 * may name another Work's Scratch, or a document the reader lost.
 */

import { type DocumentLinkAnswer, parseLinkRef, resolveDocumentHref } from "@meridian/contracts";
import { documentTitleFromUri, parseContextUri } from "@meridian/contracts/context-uri";
import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";

import { resolveDocumentLinks } from "@/client/api/document-links-api";
import {
  type InternalLinkResolver,
  indexedDocumentAt,
  indexedDocumentAtExactly,
  type LinkAnswer,
  type LinkTarget,
  type LocalLinkAnswer,
  linkTargetHref,
  type ResolvedLinkAnswer,
} from "@/core/editor/links";

import type { LinkableDocument, LinkableDocumentIndex } from "./useLinkableDocuments";

/**
 * Everything an answer is true of, besides which documents the project holds
 * (the index's revision).
 */
export type LinkResolutionScope = {
  projectId: string;
  /** Resolved Work row id, including No Work; unresolved surfaces use a pending scope. */
  workId: string;
  /** The URI of the document holding the link; what a relative link is relative to. */
  baseUri: string | null;
  /**
   * The document holding the links, when the scope is one document's text.
   * Its server questions are asked from its address, so until that address
   * arrives (a new registration) they are not asked at all: a question with
   * no holder address is chat's, which may fall back to previous locations.
   */
  holderDocumentId?: string | null;
};

const GONE: LinkAnswer = Object.freeze({ state: "gone", document: null });
const UNRESOLVED: LinkAnswer = Object.freeze({ state: "unresolved", document: null });
const UNASKED: LocalLinkAnswer = Object.freeze({ kind: "unasked" });

const answered = (answer: LinkAnswer): LocalLinkAnswer => ({ kind: "answered", answer });

export function createProjectLinkResolver(
  scope: LinkResolutionScope,
  index: LinkableDocumentIndex,
): InternalLinkResolver {
  const { projectId, workId, baseUri, holderDocumentId } = scope;
  return {
    local({ ref, target }) {
      // A relative path with no base cannot be asked; the base arriving is a
      // new registration, which asks it again.
      if (target.kind === "external" || (target.kind === "relative" && !baseUri)) return UNASKED;
      const parsed = parseLinkRef(ref);
      // A malformed ref names nothing; it never falls back to its address.
      if (ref !== null && !parsed) return answered(GONE);
      if (index.complete && parsed?.kind !== "ahead") {
        const local =
          parsed?.kind === "doc"
            ? index.documents.find((document) => document.documentId === parsed.documentId)
            : addressedDocument(index.documents, target, baseUri);
        if (local) return answered(resolvedAnswer(local));
      }
      // Rule 4 on the client, at once: an ahead ref that may still be
      // unsettled names whatever the complete index holds at exactly its
      // stored address. The server still decides; see `LocalLinkAnswer`.
      const atAddress =
        parsed?.kind === "ahead" && index.complete
          ? indexedDocumentAtExactly(index.documents, linkTargetHref(target))
          : null;
      const provisional = atAddress ? resolvedEntry(atAddress) : null;
      // A holder whose own address has not arrived asks the server nothing: a
      // question with no holder address is chat's, which may fall back to
      // previous locations.
      if (holderDocumentId && !baseUri) return provisional ? answered(provisional) : UNASKED;
      return { kind: "ask", provisional };
    },

    async remote(questions) {
      const response = await resolveDocumentLinks(projectId, {
        workId,
        baseUri,
        links: questions.map(({ ref, target }) => ({ ref, href: linkTargetHref(target) })),
      });
      if (response.answers.length !== questions.length)
        throw new Error("link resolution answered out of shape");
      return response.answers.map((answer) => (answer ? serverAnswer(answer) : null));
    },
  };
}

/** A no-ref link's local answer: the document the index holds at its address. */
function addressedDocument(
  documents: readonly LinkableDocument[],
  target: LinkTarget,
  baseUri: string | null,
): LinkableDocument | null {
  const resolved =
    target.kind === "scheme"
      ? resolveDocumentHref(target.uri, null)
      : target.kind === "relative"
        ? resolveDocumentHref(target.path, baseUri)
        : null;
  return resolved ? indexedDocumentAt(documents, resolved.uri) : null;
}

function serverAnswer(answer: DocumentLinkAnswer): LinkAnswer {
  switch (answer.state) {
    case "document": {
      const { document } = answer;
      return resolvedAnswer({
        documentId: document.id,
        title: document.title,
        uri: document.uri,
        workId: document.workId,
      });
    }
    case "gone":
      return GONE;
    case "missing":
    case "unresolvable":
      return UNRESOLVED;
  }
}

function resolvedAnswer(document: LinkableDocument): LinkAnswer {
  return resolvedEntry(document) ?? UNRESOLVED;
}

function resolvedEntry(document: LinkableDocument): ResolvedLinkAnswer | null {
  const link = resolvedLink(document);
  return link ? { state: "resolved", document: link } : null;
}

function resolvedLink(document: LinkableDocument): ResolvedDocumentLink | null {
  const parsed = parseContextUri(document.uri);
  if (!parsed.ok) return null;
  return {
    documentId: document.documentId,
    title: documentTitleFromUri(document.uri) ?? document.title,
    scheme: parsed.value.scheme,
    path: parsed.value.path,
    uri: document.uri,
    workId: document.workId,
  };
}
