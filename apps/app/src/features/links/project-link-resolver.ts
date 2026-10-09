/**
 * What the internal links of one resolution scope name: the local answer from
 * the scope's document index where it can give one, synchronously, then the
 * server for the rest, in batches.
 *
 * - A `doc:` ref the complete index holds resolves locally to that document,
 *   wherever it lives now.
 * - An `ahead:` ref the server has answered through its settlement (rule 3)
 *   is, from then on, exactly a `doc:` ref to what it settled on: the project's
 *   settlement memo keeps that fact across catalog changes, so a renumber that
 *   puts another document at the old address never answers for it, online or
 *   off.
 * - Any other `ahead:` ref asks the server, because settlement is server
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
  type DocumentAnswer,
  type InternalLinkResolver,
  indexedDocumentAt,
  indexedDocumentAtExactly,
  type LinkAnswer,
  type LinkTarget,
  type LocalLinkAnswer,
  linkTargetHref,
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
const MISSING: LinkAnswer = Object.freeze({ state: "missing", document: null });
const UNASKED: LocalLinkAnswer = Object.freeze({ kind: "unasked" });

const answered = (answer: LinkAnswer): LocalLinkAnswer => ({ kind: "answered", answer });

/**
 * What a project's ahead refs are known to have settled on: a document id, or
 * gone. A settlement never unsets (a hard delete goes to gone, which the
 * server says anyway), so a fact is written once and outlives every
 * registration and every surface in the project.
 */
type AheadSettlements = Map<string, string | "gone">;
const settlementsByProject = new Map<string, AheadSettlements>();

function projectSettlements(projectId: string): AheadSettlements {
  let settlements = settlementsByProject.get(projectId);
  if (!settlements) {
    settlements = new Map();
    settlementsByProject.set(projectId, settlements);
  }
  return settlements;
}

export function createProjectLinkResolver(
  scope: LinkResolutionScope,
  index: LinkableDocumentIndex,
): InternalLinkResolver {
  const { projectId, workId, baseUri, holderDocumentId } = scope;
  const settlements = projectSettlements(projectId);
  return {
    index,
    local({ ref, target }) {
      // A relative path with no base cannot be asked; the base arriving is a
      // new registration, which asks it again.
      if (target.kind === "external" || (target.kind === "relative" && !baseUri)) return UNASKED;
      const parsed = parseLinkRef(ref);
      // A malformed ref names nothing; it never falls back to its address.
      if (ref !== null && !parsed) return answered(GONE);
      // A settled ahead ref names what it settled on, like a doc ref; settled
      // gone names nothing the index can hold, so the server says.
      const settled = parsed?.kind === "ahead" ? settlements.get(parsed.aheadId) : undefined;
      const documentId = parsed?.kind === "doc" ? parsed.documentId : settled;
      if (index.complete && (parsed?.kind !== "ahead" || documentId)) {
        const local =
          documentId !== undefined
            ? index.documents.find((document) => document.documentId === documentId)
            : addressedDocument(index.documents, target, baseUri);
        const answer = local ? documentAnswer(local) : null;
        if (answer) return answered(answer);
      }
      // Rule 4 on the client, at once: an ahead ref not known to be settled
      // names whatever the complete index holds at exactly its stored
      // address. The server still decides; see `LocalLinkAnswer`.
      const atAddress =
        parsed?.kind === "ahead" && settled === undefined && index.complete
          ? indexedDocumentAtExactly(index.documents, linkTargetHref(target))
          : null;
      const provisional = atAddress ? documentAnswer(atAddress) : null;
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
      return response.answers.map((answer, at) => {
        if (!answer) return null;
        const ahead = parseLinkRef(questions[at]?.ref);
        const settledOn = settlementOf(answer);
        // Set once: a settlement never moves, so a later answer cannot change it.
        if (ahead?.kind === "ahead" && settledOn && !settlements.has(ahead.aheadId))
          settlements.set(ahead.aheadId, settledOn);
        return serverAnswer(answer);
      });
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

/**
 * The client's answer for the API's. `unresolvable` is no answer at all: the
 * server could not ask the question, which is not "nothing there", so it never
 * draws dashed or offers Create.
 */
function serverAnswer(answer: DocumentLinkAnswer): LinkAnswer | null {
  switch (answer.state) {
    case "document": {
      const { document } = answer;
      return documentAnswer({
        documentId: document.id,
        title: document.title,
        uri: document.uri,
        workId: document.workId,
      });
    }
    case "gone":
      return GONE;
    case "missing":
      return MISSING;
    case "unresolvable":
      return null;
  }
}

/** What a rule-3 answer says an ahead ref settled on; null for any other answer. */
function settlementOf(answer: DocumentLinkAnswer): string | "gone" | null {
  if (answer.state === "document") return answer.settled ? answer.document.id : null;
  if (answer.state === "gone") return answer.settled ? "gone" : null;
  return null;
}

function documentAnswer(document: LinkableDocument): DocumentAnswer | null {
  const link = resolvedLink(document);
  return link ? { state: "document", document: link } : null;
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
