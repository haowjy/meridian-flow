/** Scoped internal-link lookup over a source's live tree and Work authority. */

import type { DocumentId } from "@meridian/contracts";
import {
  type ContextUriScheme,
  canonicalContextUri,
  documentTitleFromUri,
  isProjectScopedScheme,
  matchDocumentPath,
  parseContextUri,
} from "@meridian/contracts";
import type { ContextSource, ContextSourceOwner } from "@meridian/contracts/protocol";
import type { ProjectWorkAuthorityResolver } from "../projects/domain/work-authority.js";
import type { ChatUploadsOwners } from "./chat-uploads-owners.js";
import type { ContextSources } from "./ports/context-sources.js";
import type {
  DocumentLinkHistory,
  DocumentLinkResolver,
  ResolveDocumentLinkInput,
  ResolvedDocumentLink,
} from "./ports/document-link-resolver.js";

/** Whose source an address is in; `user` is the reader's own list. */
type Owner = ContextSourceOwner | { kind: "user" };
type Location = { owner: Owner; scheme: ContextUriScheme; path: string };

export function createDocumentLinkResolver({
  sources,
  workAuthorityResolver,
  history,
  lineages,
  chats,
}: {
  sources: ContextSources;
  lineages?: import("./scratch-owner.js").ScratchLineages;
  chats?: ChatUploadsOwners;
  history?: DocumentLinkHistory;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
}): DocumentLinkResolver {
  async function currentOwner(input: ResolveDocumentLinkInput): Promise<Owner | null> {
    const work = input.workId
      ? await workAuthorityResolver.byId(input.projectId, input.workId)
      : await workAuthorityResolver.noWork(input.projectId);
    return work ? { kind: "work", workId: work.workId } : null;
  }
  async function location(input: ResolveDocumentLinkInput, uri: string): Promise<Location | null> {
    const parsed = parseContextUri(uri);
    if (!parsed.ok || !parsed.value.path) return null;
    const { scheme, path, authority } = parsed.value;
    let scope: Owner | null;
    if (scheme === "user") scope = { kind: "user" };
    else if (isProjectScopedScheme(scheme)) scope = { kind: "project" };
    else if (scheme === "scratch" && authority.kind === "lineage") {
      const lineage = await lineages?.byRef(input.projectId, authority.rootThreadRef);
      scope = lineage ? { kind: "lineage", rootThreadId: lineage.rootThreadId } : null;
    } else if (scheme === "scratch" && authority.kind === "contextual" && input.rootThreadId) {
      const lineage = await lineages?.byId(input.projectId, input.rootThreadId);
      scope = lineage ? { kind: "lineage", rootThreadId: lineage.rootThreadId } : null;
    } else if (scheme === "uploads") {
      // Uploads belong to a chat; a Work owns none, so `uploads://@w3/` names nothing.
      const chatId =
        authority.kind === "chat"
          ? (await chats?.byRef(input.projectId, authority.chatRef))?.chatId
          : authority.kind === "contextual"
            ? // A bare name means the holder chat's file. A document holder has no chat: the
              // write path qualifies model-written embeds, so a stored bare one stays unresolved.
              input.chatId
            : null;
      scope = chatId ? { kind: "chat", chatId } : null;
    } else if (authority.kind === "work") {
      const work = await workAuthorityResolver.byHandle(input.projectId, authority.workHandle);
      scope = work ? { kind: "work", workId: work.workId } : null;
    } else scope = await currentOwner(input);
    return scope ? { owner: scope, scheme, path } : null;
  }
  async function atUri(
    input: ResolveDocumentLinkInput,
    uri: string,
    allowHistory: boolean,
  ): Promise<ResolvedDocumentLink | null> {
    const address = await location(input, uri);
    if (!address) return null;
    const candidates =
      address.owner.kind === "user"
        ? await sources.ofUser(input.userId)
        : await sources.ownedBy(input.projectId, address.owner);
    const source = candidates.find((candidate) => candidate.scheme === address.scheme);
    if (!source) return null;
    const files = await sources.liveDocuments(source.id);
    const match = matchDocumentPath(files, address.path, (file) => file.path);
    if (match) return resolvedLink(source, match);
    const previous = allowHistory
      ? await history?.previous(input, { sourceId: source.id, path: address.path })
      : null;
    return previous ? atUri(input, previous, false) : null;
  }
  return {
    async resolve(input) {
      return atUri(input, input.uri, input.previousLocations === true);
    },
  };
}

function resolvedLink(
  source: ContextSource,
  file: { id: DocumentId; path: string },
): ResolvedDocumentLink {
  const uri = canonicalContextUri(source.scheme, file.path, source.authority);
  return {
    documentId: file.id,
    title: documentTitleFromUri(uri) ?? file.path.slice(file.path.lastIndexOf("/") + 1),
    scheme: source.scheme,
    path: file.path,
    uri,
    ...(source.owner.kind === "lineage" ? { rootThreadId: source.owner.rootThreadId } : {}),
    ...(source.owner.kind === "chat" ? { chatThreadId: source.owner.chatId } : {}),
    workId: source.owner.kind === "work" ? source.owner.workId : null,
  };
}
