/**
 * What an internal link addresses in one resolution scope: the local answer
 * from the scope's document index, then the server.
 *
 * The local projection applies the server's address rule
 * (`matchDocumentPath`) to the documents the index holds, so a link the index
 * can answer costs no request. It only answers when the index is complete; an
 * incomplete one cannot prove which document is at an address.
 */

import { matchDocumentPath, resolveDocumentHref } from "@meridian/contracts";
import { documentTitleFromUri, parseContextUri } from "@meridian/contracts/context-uri";
import type { DocumentLinkTarget, ResolvedDocumentLink } from "@meridian/contracts/protocol";

import { resolveDocumentLink } from "@/client/api/document-links-api";
import { documentLinkTarget, type InternalLinkResolver, linkTargetHref } from "@/core/editor/links";

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
   * A server fallback names it, so the server can answer a link the holder
   * has not been rewritten for yet through its pending redirect. Chat holds no
   * links, so it has none.
   */
  holderDocumentId?: string | null;
  /**
   * How many times the holder's text has changed in this editor. Local, never
   * sent: it is only a reason to register again, so an answer cannot outlive
   * the text it answered once a rewrite (or any edit) has landed.
   */
  documentRevision?: number;
};

/** The document at the address, or null when only the server can say. */
function projectLinkAnswer(
  index: LinkableDocumentIndex,
  request: DocumentLinkTarget,
): ResolvedDocumentLink | null {
  if (!index.complete) return null;
  const match = localMatch(index.documents, request);
  return match ? resolvedLink(match) : null;
}

/**
 * Local answer first, then `resolveDocumentLink`. Nothing local at the address
 * still asks the server: the index may not hold the scope the address names
 * (another Work's Scratch).
 */
export function createProjectLinkResolver(
  scope: LinkResolutionScope,
  index: LinkableDocumentIndex,
): InternalLinkResolver {
  const { projectId, workId, baseUri, holderDocumentId } = scope;
  return async (target) => {
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
    const local = projectLinkAnswer(index, request);
    if (local) return local;
    const holder = holderDocumentId
      ? { documentId: holderDocumentId, href: linkTargetHref(target) }
      : undefined;
    const { document } = await resolveDocumentLink(projectId, {
      workId,
      ...(holder ? { holder } : {}),
      target: request,
    });
    return document;
  };
}

function localMatch(
  documents: readonly LinkableDocument[],
  target: DocumentLinkTarget,
): LinkableDocument | null {
  const resolved =
    target.kind === "scheme"
      ? resolveDocumentHref(target.uri, null)
      : resolveDocumentHref(target.path, target.baseUri);
  const requested = resolved ? parseContextUri(resolved.uri) : null;
  if (!requested?.ok) return null;
  const { scheme, path, authority } = requested.value;
  const candidates = documents.flatMap((document) => {
    const candidate = parseContextUri(document.uri);
    if (!candidate.ok || candidate.value.scheme !== scheme) return [];
    // A contextual address means the scope's own Work, which is the only Work
    // whose Scratch and Uploads the index holds.
    if (
      authority.kind !== "contextual" &&
      JSON.stringify(candidate.value.authority) !== JSON.stringify(authority)
    )
      return [];
    return [{ document, path: candidate.value.path }];
  });
  return matchDocumentPath(candidates, path, (candidate) => candidate.path)?.document ?? null;
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
