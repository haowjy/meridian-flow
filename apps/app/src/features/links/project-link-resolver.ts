/**
 * What the internal links of one resolution scope name: the local answer the
 * shared link rules give over the scope's catalog (`project-link-catalog.ts`),
 * synchronously, then the server for the rest, in batches. This module holds
 * only that split, the transport, and what a server answer teaches the
 * settlement memo; the rules are `resolveStoredLink`'s.
 *
 * - A `doc:` ref, or an `ahead:` ref the memo knows settled on a document,
 *   resolves locally when the complete index holds that document, wherever it
 *   lives now. A settled ref never answers by its old address again, online
 *   or off, so a renumber that puts another document there never answers
 *   for it.
 * - Any other `ahead:` ref asks the server, because settlement is server
 *   state. Until it answers, a document the complete index holds at exactly
 *   the ref's stored address is the answer, shown at once (a Follow-Create,
 *   say, before the server has settled the ref). Only a server `document`
 *   naming another document, or `gone`, replaces it; with nothing there, the
 *   server's `missing` is "doesn't exist yet".
 * - A link with no ref resolves by its address: the complete index first
 *   (`matchDocumentPath`, through the catalog's `documentFor`), then the
 *   server.
 * - A folder (a `folder:` ref, or a directory address) answers only from the
 *   index. The resolve endpoint's answers name documents, so a folder the
 *   index does not hold (another Work's Scratch) stays unasked: drawn filled,
 *   and its menu looks the folder up by identity when it opens.
 */

import {
  type DocumentLinkAnswer,
  parseLinkRef,
  resolveDocumentHref,
  resolveStoredLink,
} from "@meridian/contracts";
import { documentTitleFromUri, parseContextUri } from "@meridian/contracts/context-uri";
import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";

import { resolveDocumentLinks } from "@/client/api/document-links-api";
import {
  type DocumentAnswer,
  type InternalLinkResolver,
  type LinkAnswer,
  type LinkTarget,
  type LocalLinkAnswer,
  linkTargetAddress,
  linkTargetHref,
} from "@/core/editor/links";

import type { LinkSettlements } from "./link-settlements";
import { createProjectLinkCatalog } from "./project-link-catalog";
import type { LinkableDocument, LinkableDocumentIndex } from "./useLinkableDocuments";

/**
 * Everything an answer is true of, besides which documents the project holds
 * (the index's revision).
 */
export type LinkResolutionScope = {
  projectId: string;
  /** Resolved Work row id, including No Work; unresolved surfaces use a pending scope. */
  workId: string;
  /**
   * The lineage a bare `scratch://` means, in a No Work chat or in a note of a
   * lineage. The server takes it in place of the Work.
   */
  rootThreadId?: string | null;
  /** The chat a bare `uploads://` means: the chat itself, or a subagent's top chat. */
  chatId?: string | null;
  /** The URI of the document holding the link; what a relative link is relative to. */
  baseUri: string | null;
  /**
   * The document holding the links, when the scope is one document's text. The
   * server pins this identity and its current address; only a relative target
   * without a base URI remains unasked on the client.
   */
  holderDocumentId?: string | null;
};

const GONE: Extract<LinkAnswer, { state: "gone" }> = Object.freeze({
  state: "gone",
  document: null,
});
const MISSING: LinkAnswer = Object.freeze({ state: "missing", document: null });
const UNASKED: LocalLinkAnswer = Object.freeze({ kind: "unasked" });

const answered = (answer: LinkAnswer): LocalLinkAnswer => ({ kind: "answered", answer });

export function createProjectLinkResolver(
  scope: LinkResolutionScope,
  index: LinkableDocumentIndex,
  settlements: LinkSettlements,
): InternalLinkResolver {
  const { projectId, workId, rootThreadId, chatId, baseUri, holderDocumentId } = scope;
  const memo = settlements.forProject(projectId);
  const catalog = createProjectLinkCatalog(projectId, index, memo);
  const indexedAnswer = (documentId: string) => {
    const document = catalog.indexed(documentId);
    return document ? documentAnswer(document) : null;
  };
  return {
    index,
    local({ ref, target }) {
      // A relative path with no base cannot be asked; the base arriving is a
      // new registration, which asks it again.
      if (target.kind === "external" || (target.kind === "relative" && !baseUri)) return UNASKED;
      const resolution = resolveStoredLink({ ref, href: linkTargetHref(target) }, catalog);
      let provisional: DocumentAnswer | null = null;
      if (resolution.kind === "gone") return answered(GONE);
      if (resolution.kind === "folder") {
        const folder = catalog.indexedFolder(resolution.folder.folderId);
        return folder
          ? answered({
              state: "folder",
              document: null,
              folder: { folderId: folder.folderId, title: folder.title, uri: folder.uri },
            })
          : UNASKED;
      }
      if (namesFolder(ref, target, baseUri)) return UNASKED;
      if (resolution.kind === "address") {
        const uri = linkTargetAddress(target, baseUri);
        const document = uri ? catalog.documentFor(uri) : null;
        const answer = document ? indexedAnswer(document.documentId) : null;
        if (answer) return answered(answer);
      }
      if (resolution.kind === "document") {
        const answer = indexedAnswer(resolution.document.documentId);
        // Rule 4 (an ahead ref not known settled, at its exact address) is
        // the server's to confirm; see `LocalLinkAnswer`.
        const confirmed = resolution.settled || parseLinkRef(ref)?.kind === "doc";
        if (answer && confirmed) return answered(answer);
        provisional = answer;
      }
      return { kind: "ask", provisional };
    },

    async remote(questions) {
      const response = await resolveDocumentLinks(projectId, {
        ...(rootThreadId ? { rootThreadId } : { workId }),
        ...(chatId ? { chatId } : {}),
        baseUri,
        ...(holderDocumentId ? { holderDocumentId } : {}),
        links: questions.map(({ ref, target }) => ({ ref, href: linkTargetHref(target) })),
      });
      if (response.answers.length !== questions.length)
        throw new Error("link resolution answered out of shape");
      return response.answers.map((answer, at) => {
        if (!answer) return null;
        const question = questions[at];
        const ahead = parseLinkRef(question?.ref);
        const settledOn = settlementOf(answer);
        if (ahead?.kind === "ahead" && settledOn !== undefined)
          memo.learn(ahead.aheadId, settledOn);
        return serverAnswer(answer);
      });
    },
  };
}

/** A folder ref, or a directory address: questions only the local index answers. */
function namesFolder(ref: string | null, target: LinkTarget, baseUri: string | null): boolean {
  if (ref !== null) return parseLinkRef(ref)?.kind === "folder";
  const href = linkTargetHref(target);
  return resolveDocumentHref(href, target.kind === "relative" ? baseUri : null)?.kind === "folder";
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
      const found = documentAnswer({
        documentId: document.id,
        title: document.title,
        uri: document.uri,
        workId: document.workId,
        rootThreadId: document.rootThreadId ?? undefined,
      });
      // A hidden document is "in a draft": keep the destination the server named.
      return found && answer.inBranch && answer.branch
        ? { ...found, branch: answer.branch }
        : found;
    }
    case "gone":
      return answer.trashedDocumentId
        ? { ...GONE, trashedDocumentId: answer.trashedDocumentId }
        : GONE;
    case "missing":
      return MISSING;
    case "unresolvable":
      return null;
  }
}

/**
 * What a rule-3 answer says an ahead ref settled on: its document, null for
 * settled gone (identity unknown), undefined for any other answer.
 */
function settlementOf(answer: DocumentLinkAnswer): string | null | undefined {
  if (answer.state === "document") return answer.settled ? answer.document.id : undefined;
  if (answer.state === "gone") return answer.settled ? null : undefined;
  return undefined;
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
    ...(document.rootThreadId ? { rootThreadId: document.rootThreadId } : {}),
  };
}
