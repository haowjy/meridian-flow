/**
 * What an internal link addresses in one resolution scope: the local answer
 * from the scope's document index, then the server.
 *
 * The local projection mirrors the server resolver over the documents the
 * index holds, so a link the index can answer costs no request. It only
 * answers when the index is complete; an incomplete one cannot prove that a
 * single match is the only match.
 */

import { documentTitleFromUri, parseContextUri } from "@meridian/contracts/context-uri";
import type { DocumentLinkTarget, ResolvedDocumentLink } from "@meridian/contracts/protocol";

import { resolveDocumentLink } from "@/client/api/document-links-api";
import { documentLinkTarget, type InternalLinkResolver } from "@/core/editor/links";

import type { LinkableDocument, LinkableDocumentIndex } from "./useLinkableDocuments";

/**
 * Everything an answer is true of, besides which documents the project holds
 * (the index's revision).
 */
export type LinkResolutionScope = {
  projectId: string;
  /** Named Work or No Work row id; null is public No Work (`@/`). */
  workId: string | null;
  /** The URI of the document holding the link; what a relative link is relative to. */
  baseUri: string | null;
};

export type ProjectedLinkAnswer =
  | { kind: "resolved"; document: ResolvedDocumentLink }
  /** A complete index with more than one match. */
  | { kind: "ambiguous"; candidates: readonly ResolvedDocumentLink[] }
  /** Zero local matches, or an incomplete index: only the server can say. */
  | { kind: "unknown" };

const UNKNOWN: ProjectedLinkAnswer = { kind: "unknown" };

export function projectLinkAnswer(
  index: LinkableDocumentIndex,
  request: DocumentLinkTarget,
): ProjectedLinkAnswer {
  if (!index.complete) return UNKNOWN;
  const matches = localMatches(index.documents, request);
  const [only] = matches;
  if (!only) return UNKNOWN;
  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      candidates: matches.flatMap((document) => resolvedLink(document) ?? []),
    };
  }
  const document = resolvedLink(only);
  return document ? { kind: "resolved", document } : UNKNOWN;
}

/** Local answer first, then `resolveDocumentLink`. Ambiguous resolves to null (drawn unresolved). */
export function createProjectLinkResolver(
  scope: LinkResolutionScope,
  index: LinkableDocumentIndex,
): InternalLinkResolver {
  const { projectId, workId, baseUri } = scope;
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
    if (local.kind === "resolved") return local.document;
    if (local.kind === "ambiguous") return null;
    const { document } = await resolveDocumentLink(projectId, { workId, target: request });
    return document;
  };
}

function localMatches(
  documents: readonly LinkableDocument[],
  target: DocumentLinkTarget,
): readonly LinkableDocument[] {
  if (target.kind === "wikilink") {
    const name = target.name.trim().toLowerCase();
    return documents.filter((document) =>
      [document.filename, document.title, ...document.aliases].some(
        (candidate) => candidate.trim().toLowerCase() === name,
      ),
    );
  }
  const base = parseContextUri(target.kind === "scheme" ? target.uri : target.baseUri);
  if (!base.ok || !base.value.path) return [];
  const requestedPath =
    target.kind === "relative"
      ? relativeDocumentPath(base.value.path, target.path)
      : base.value.path;
  if (!requestedPath) return [];
  return documents.filter((document) => {
    const candidate = parseContextUri(document.uri);
    if (!candidate.ok || candidate.value.scheme !== base.value.scheme) return false;
    if (!sameDocumentPath(candidate.value.path, requestedPath)) return false;
    if (base.value.authority.kind === "contextual") return true;
    return JSON.stringify(candidate.value.authority) === JSON.stringify(base.value.authority);
  });
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

/** A path matches with or without its extension, as the server's does. */
function sameDocumentPath(candidate: string, requested: string): boolean {
  return (
    candidate === requested ||
    (candidate.lastIndexOf(".") > candidate.lastIndexOf("/") &&
      candidate.slice(0, candidate.lastIndexOf(".")) === requested)
  );
}

function relativeDocumentPath(base: string, relative: string): string | null {
  if (!relative || relative.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(relative)) return null;
  const segments = base.split("/");
  segments.pop();
  for (const part of relative.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else segments.push(part);
  }
  return segments.length > 0 ? segments.join("/") : null;
}
