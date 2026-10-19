/** Checked owner construction at command boundaries and one durable URI authority rule. */
import {
  isOwnedContextScheme,
  type ParsedContextAuthority,
  parsedContextUriFromSourceLocation,
} from "@meridian/contracts/context-uri";
import type { CatalogScope, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { decodeWorkSlug } from "@meridian/contracts/works";
import type { ResourceOwner } from "./resource-records";

/** The locked row is separate from named Works in the project's authoritative snapshot. */
export function resourceWorkAuthorityFor(
  workId: string,
  snapshot: { works: readonly { id: string; slug: string | null }[]; noWork: { id: string } },
): ResourceOwner {
  if (workId === snapshot.noWork.id) return { workId, workSlug: null };
  const work = snapshot.works.find((candidate) => candidate.id === workId);
  if (!work?.slug) throw new Error("The destination Work has no known named authority");
  return { workId: work.id, workSlug: work.slug };
}

/** The owner a lineage catalog entry asserts: the scope's first-chat id and the handle its URI spells. */
export function resourceLineageOwner(
  scope: Extract<CatalogScope, { kind: "lineage" }>,
  rootThreadRef: string,
): ResourceOwner {
  return { workId: null, rootThreadId: scope.rootThreadId, rootThreadRef };
}

/** The owner a chat catalog entry asserts: the scope's chat id and the handle its URI spells. */
export function resourceChatOwner(
  scope: Extract<CatalogScope, { kind: "chat" }>,
  chatRef: string | null,
): ResourceOwner {
  return { workId: null, chatId: scope.chatId, chatRef };
}

/** What a location's owner spells in a context URI. */
export type ResourceContextAuthority =
  | { kind: "contextual" }
  | { kind: "none" }
  | { kind: "work"; workSlug: string }
  | { kind: "lineage"; rootThreadRef: string }
  | { kind: "chat"; chatRef: string | null };

/** Journal identity was checked against a Works snapshot or asserted by a scoped server catalog. */
export function resourceContextAuthority(
  scheme: ProjectContextTreeScheme,
  owner: {
    workId: string | null;
    workSlug?: string | null;
    rootThreadId?: string | null;
    rootThreadRef?: string | null;
    chatId?: string | null;
    chatRef?: string | null;
  },
): ResourceContextAuthority {
  if (!isOwnedContextScheme(scheme)) return { kind: "contextual" };
  if (scheme === "uploads") {
    if (!owner.chatId || owner.workId !== null) throw new Error("Uploads require a chat owner");
    return { kind: "chat", chatRef: owner.chatRef ?? null };
  }
  if (owner.chatId) throw new Error("Chat authority requires Uploads");
  if (owner.rootThreadId) {
    if (owner.workId !== null || !owner.rootThreadRef)
      throw new Error("Lineage authority requires Scratch and a first-chat handle");
    return { kind: "lineage", rootThreadRef: owner.rootThreadRef };
  }
  if (!owner.workId || owner.workSlug === undefined)
    throw new Error("Work-scoped authority requires a known Work identity");
  return owner.workSlug === null ? { kind: "none" } : { kind: "work", workSlug: owner.workSlug };
}

/**
 * A location's URI, spelled by the contracts serializer from its owner's authority. A chat that
 * does not exist yet has no handle, so its uploads take the contextual form. Null when the
 * authority names no valid Work.
 */
export function resourceContextUri(
  scheme: ProjectContextTreeScheme,
  path: string,
  authority: ResourceContextAuthority,
): string | null {
  const bare = path.replace(/^\/+/, "");
  switch (authority.kind) {
    case "work": {
      const workSlug = decodeWorkSlug(authority.workSlug);
      return workSlug
        ? parsedContextUriFromSourceLocation(scheme, bare, { kind: "work", workSlug })
        : null;
    }
    case "chat":
      return parsedContextUriFromSourceLocation(
        scheme,
        bare,
        authority.chatRef === null
          ? { kind: "contextual" }
          : { kind: "chat", chatRef: authority.chatRef },
      );
    default:
      return parsedContextUriFromSourceLocation(scheme, bare, authority);
  }
}

/** The owner a catalog entry asserts through its scope and the authority its URI spells. */
export function catalogEntryOwner(
  scope: CatalogScope,
  authority: ParsedContextAuthority,
): ResourceOwner {
  if (scope.kind === "lineage")
    return authority.kind === "lineage"
      ? resourceLineageOwner(scope, authority.rootThreadRef)
      : { workId: null };
  if (scope.kind === "chat")
    // A chat that does not exist yet has no handle, so its uploads spell a bare URI.
    return resourceChatOwner(scope, authority.kind === "chat" ? authority.chatRef : null);
  if (scope.kind !== "work") return { workId: null };
  return { workId: scope.workId, workSlug: authority.kind === "work" ? authority.workSlug : null };
}

/** Whether a catalog scope is where this owner's documents are listed. */
export function ownerListedInScope(
  owner: ResourceOwner,
  scheme: ProjectContextTreeScheme,
  scope: CatalogScope,
  projectId: string,
): boolean {
  if (owner.chatId !== undefined) return scope.kind === "chat" && scope.chatId === owner.chatId;
  if (owner.rootThreadId !== undefined)
    return scope.kind === "lineage" && scope.rootThreadId === owner.rootThreadId;
  if (owner.workId !== null) return scope.kind === "work" && scope.workId === owner.workId;
  return scheme === "user"
    ? scope.kind === "user"
    : scope.kind === "project" && scope.projectId === projectId;
}

/** The owner fields a move request carries for its source and destination locations. */
export function moveOwnerFields(source: ResourceOwner, destination: ResourceOwner) {
  return {
    sourceWorkSlug: source.workSlug ?? null,
    destinationWorkSlug: destination.workSlug ?? null,
    sourceRootThreadRef: source.rootThreadRef ?? null,
    destinationRootThreadRef: destination.rootThreadRef ?? null,
    body: {
      sourceWorkId: source.workId,
      destinationWorkId: destination.workId,
      sourceRootThreadId: source.rootThreadId ?? null,
      destinationRootThreadId: destination.rootThreadId ?? null,
    },
  };
}
