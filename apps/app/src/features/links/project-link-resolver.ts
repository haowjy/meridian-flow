/**
 * What the internal links of one resolution scope name: the local answer from
 * the scope's document index where it can give one, then the server, in one
 * batched request.
 *
 * - A `doc:` ref the complete index holds resolves locally to that document,
 *   wherever it lives now.
 * - An `ahead:` ref always asks the server, because settlement is server
 *   state. A `document` or `gone` answer is final. A `missing` answer means
 *   the ref is unsettled, so it resolves by its exact stored address: a
 *   document the complete index holds there is the answer (a Follow-Create,
 *   say, before the server has settled the ref), and nothing there is missing.
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
  documentLinkTarget,
  type InternalLinkResolver,
  indexedDocumentAt,
  indexedDocumentAtExactly,
  type LinkAnswer,
  type LinkTarget,
  linkTargetHref,
  MAX_BATCH,
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
  /**
   * How many times the holder's text has changed in this editor. Local, never
   * sent: it is only a reason to register again, so an answer cannot outlive
   * the text it answered once a rewrite (or any edit) has landed.
   */
  documentRevision?: number;
};

const GONE: LinkAnswer = Object.freeze({ state: "gone", document: null });
const UNRESOLVED: LinkAnswer = Object.freeze({ state: "unresolved", document: null });

type ServerQuestion = { at: number; ref: string | null; href: string; ahead: boolean };

export function createProjectLinkResolver(
  scope: LinkResolutionScope,
  index: LinkableDocumentIndex,
): InternalLinkResolver {
  const { projectId, workId, baseUri, holderDocumentId } = scope;
  return async (questions) => {
    // Null for a question that could not be asked: a relative path with no
    // base, or a holder whose own address has not arrived. An unasked question
    // must not render as a missing document; the base arriving is a new
    // registration, which asks it again.
    const answers: (LinkAnswer | null)[] = questions.map(() => null);
    const remote: ServerQuestion[] = [];
    questions.forEach(({ ref, target }, at) => {
      const request = documentLinkTarget(target, baseUri ?? "");
      if (!request || (request.kind === "relative" && !baseUri)) return;
      const parsed = parseLinkRef(ref);
      // A malformed ref names nothing; it never falls back to its address.
      if (ref !== null && !parsed) {
        answers[at] = GONE;
        return;
      }
      const local = !index.complete
        ? null
        : parsed?.kind === "doc"
          ? (index.documents.find((document) => document.documentId === parsed.documentId) ?? null)
          : parsed === null
            ? addressedDocument(index.documents, target, baseUri)
            : null;
      if (local) {
        answers[at] = resolvedAnswer(local);
        return;
      }
      if (holderDocumentId && !baseUri) return;
      remote.push({ at, ref, href: linkTargetHref(target), ahead: parsed?.kind === "ahead" });
    });

    for (let start = 0; start < remote.length; start += MAX_BATCH) {
      const batch = remote.slice(start, start + MAX_BATCH);
      const response = await resolveDocumentLinks(projectId, {
        workId,
        baseUri,
        links: batch.map(({ ref, href }) => ({ ref, href })),
      });
      if (response.answers.length !== batch.length)
        throw new Error("link resolution answered out of shape");
      batch.forEach((question, offset) => {
        const answer = response.answers[offset];
        if (answer) answers[question.at] = serverAnswer(answer, question, index);
      });
    }
    return answers;
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

function serverAnswer(
  answer: DocumentLinkAnswer,
  question: ServerQuestion,
  index: LinkableDocumentIndex,
): LinkAnswer {
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
    case "missing": {
      // Rule 4 on the client: an unsettled ahead ref names whatever the
      // complete local index holds at exactly its stored address.
      const local =
        question.ahead && index.complete
          ? indexedDocumentAtExactly(index.documents, question.href)
          : null;
      return local ? resolvedAnswer(local) : UNRESOLVED;
    }
    case "unresolvable":
      return UNRESOLVED;
  }
}

function resolvedAnswer(document: LinkableDocument): LinkAnswer {
  const link = resolvedLink(document);
  return link ? { state: "resolved", document: link } : UNRESOLVED;
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
