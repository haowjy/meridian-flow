import {
  type DocumentLinkAnswer,
  parseLinkRef,
  resolveStoredLink,
  resolveStoredLinkAddress,
} from "@meridian/contracts";
import { documentTitleFromUri, parseContextUri } from "@meridian/contracts/context-uri";
import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";

import { resolveDocumentLinks } from "@/client/api/document-links-api";
import type { LinkSettlements } from "@/client/link-settlements";
import {
  type DocumentAnswer,
  type InternalLinkResolver,
  type LinkAnswer,
  type LocalLinkAnswer,
  linkTargetHref,
} from "@/core/editor/links";
import { createProjectLinkCatalog } from "./project-link-catalog";
import type { LinkableDocument, LinkableDocumentIndex } from "./useLinkableDocuments";

export type LinkResolutionScope = {
  projectId: string;
  workId: string;
  rootThreadId?: string | null;
  chatThreadId?: string | null;
  baseUri: string | null;
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
  const { projectId, workId, rootThreadId, chatThreadId, baseUri, holderDocumentId } = scope;
  const memo = settlements.forProject(projectId);
  const catalog = createProjectLinkCatalog(projectId, index, memo);
  const indexedAnswer = (documentId: string) => {
    const document = catalog.indexed(documentId);
    return document ? documentAnswer(document) : null;
  };
  return {
    index,
    local({ ref, target }) {
      if (target.kind === "external" || (target.kind === "relative" && !baseUri)) return UNASKED;
      const link = { ref, href: linkTargetHref(target) };
      const address = resolveStoredLinkAddress(link, baseUri);
      const resolution = resolveStoredLink(link, address, catalog);
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
      if (resolution.kind === "address") {
        const document = address?.kind === "document" ? catalog.documentFor(address.uri) : null;
        const answer = document ? indexedAnswer(document.documentId) : null;
        if (answer) return answered(answer);
      }
      if (resolution.kind === "document") {
        const answer = indexedAnswer(resolution.document.documentId);
        const confirmed = resolution.settled || parseLinkRef(ref)?.kind === "doc";
        const sizeUnknown = answer?.document.file && answer.document.file.fileType !== "image";
        if (answer && confirmed && !sizeUnknown) return answered(answer);
        provisional = answer;
      }
      return { kind: "ask", provisional };
    },

    async remote(questions) {
      const response = await resolveDocumentLinks(projectId, {
        ...(rootThreadId ? { rootThreadId } : { workId }),
        ...(chatThreadId ? { chatId: chatThreadId } : {}),
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
      if (found && document.file) found.document.file = document.file;
      return found && answer.inDraft && answer.draft ? { ...found, draft: answer.draft } : found;
    }
    case "folder":
      return {
        state: "folder",
        document: null,
        folder: {
          folderId: answer.folder.id,
          title: answer.folder.name,
          uri: answer.folder.uri,
        },
      };
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
    ...(document.file ? { file: { ...document.file, sizeBytes: null } } : {}),
  };
}
