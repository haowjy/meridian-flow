/** A plain address resolves against the replay of the list: to a document, to "not there", or to "waiting for the list". */

import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type {
  CatalogFileEntry,
  CatalogScope,
  DocumentAddressResult,
  ProjectContextAuthority,
} from "@meridian/contracts/protocol";
import { resolveIn, type TreeViewResult } from "@/client/query/useProjectTree";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import type { TreeFile } from "@/core/project-tree/tree-view";
import { resolveLiveRouteDocument } from "../context/route-document-owner";
import { type ProjectAddress, type ProjectDestination, scratchOwnerKey } from "./project-address";

type DocumentDestination = Extract<ProjectDestination, { kind: "document" }>;
export function canonicalDocumentPath(path: string): string {
  return path.replace(/^\/+/, "");
}

/**
 * Whether the address already names this document. A Scratch document is addressed by its owner,
 * so the target must name that owner; any other document is its path alone, whatever the scope.
 * When both sides know the document, identity alone decides: a reused path never makes two
 * documents one. The path is only the fallback while either identity is unresolved.
 */
export function projectAddressMatchesContextTarget(
  address: ProjectAddress,
  target: {
    scheme: string;
    path: string;
    workId?: string;
    rootThreadId?: string;
    documentId?: string;
  },
  /** The document the address resolved to, absent while it is still resolving. */
  addressDocumentId?: string,
): boolean {
  const destination = address.destination;
  if (destination.kind !== "document") return false;
  if (target.scheme === "scratch") {
    if (target.workId === undefined && target.rootThreadId === undefined) return false;
    const owner = scratchOwnerKey({
      workId: target.workId ?? "",
      rootThreadId: target.rootThreadId,
    });
    if (address.owner !== owner) return false;
  }
  return sameDocument(destination, target, addressDocumentId);
}

/** Identity decides once both sides know the document; the path is only the fallback. */
function sameDocument(
  destination: DocumentDestination,
  target: { scheme: string; path: string; documentId?: string },
  addressDocumentId: string | undefined,
): boolean {
  if (target.documentId !== undefined && addressDocumentId !== undefined)
    return target.documentId === addressDocumentId;
  return (
    destination.scheme === target.scheme &&
    canonicalDocumentPath(destination.path) === canonicalDocumentPath(target.path)
  );
}

/** What the address found in the replay; `held`: the route's bound document is not in this source's tree. */
export type ReplayAddress =
  | { kind: "found"; result: DocumentAddressResult; file: TreeFile }
  | { kind: "absent" | "waiting" | "held" };

/** The authority of the document's source: what the address's owner and the file's URI say. */
function authorityOf(
  file: TreeFile,
  input: {
    projectId: string;
    accountId: string;
    workId: string | null;
    rootThreadId: string | null;
  },
  scheme: string,
): ProjectContextAuthority | null {
  if (scheme === "user") return { kind: "user", userId: input.accountId };
  if (scheme !== "scratch") return { kind: "project", projectId: input.projectId };
  const uri = parseUnifiedContextUri(file.uri);
  if (!uri.ok) return null;
  if (input.rootThreadId) {
    if (uri.value.authority.kind !== "lineage") return null;
    return {
      kind: "lineage",
      projectId: input.projectId,
      rootThreadId: input.rootThreadId,
      rootThreadRef: uri.value.authority.rootThreadRef,
    };
  }
  if (!input.workId || uri.value.authority.kind === "contextual") return null;
  return {
    kind: "work",
    projectId: input.projectId,
    workId: input.workId,
    workHandle: uri.value.authority.kind === "work" ? uri.value.authority.workHandle : null,
  };
}

function scopeOf(authority: ProjectContextAuthority): CatalogScope {
  if (authority.kind === "chat")
    return { kind: "chat", projectId: authority.projectId, chatId: authority.chatId };
  if (authority.kind === "user") return { kind: "user", userId: authority.userId };
  if (authority.kind === "work")
    return { kind: "work", projectId: authority.projectId, workId: authority.workId };
  if (authority.kind === "lineage")
    return {
      kind: "lineage",
      projectId: authority.projectId,
      rootThreadId: authority.rootThreadId,
    };
  return { kind: "project", projectId: authority.projectId };
}

/** The server's shape of the file, for the answers (canonical address, tab) built from one. */
function entryOf(file: TreeFile, sourceId: string, authority: ProjectContextAuthority) {
  const classification = file.editable
    ? { editable: true, filetype: file.filetype, schemaType: file.schemaType }
    : {
        editable: false,
        disposition: file.disposition,
        fileType: file.fileType,
        mimeType: file.mimeType ?? null,
        ...(file.disposition === "custom" ? { filetype: file.filetype } : {}),
      };
  return {
    kind: "file",
    observationVersion: "0",
    entryId: file.documentId,
    scope: scopeOf(authority),
    sourceId,
    parentId: file.parentId,
    name: file.name,
    aliases: file.aliases ?? [],
    path: file.path.split("/").filter(Boolean),
    uri: file.uri,
    provisionalName: file.provisionalName,
    hasProperties: file.hasProperties,
    extension: file.extension,
    ...classification,
  } as unknown as CatalogFileEntry;
}

/**
 * Where a plain address is in the replay. The document the route is bound to is the route's
 * document wherever its path went (the path is its current label, and admission repairs the URL
 * to it); with no bound identity the path's occupant is. A bound document this source's tree
 * lacks is never answered by the path's occupant: the route holds until it is found elsewhere or
 * gone (`holdsBoundDocument`). An address that finds nothing is "not there" only once the list
 * has synced.
 */
export function resolveReplayAddress(input: {
  projectId: string;
  accountId: string;
  destination: DocumentDestination;
  workId: string | null;
  /** The lineage a Scratch address names, in place of a Work. */
  rootThreadId: string | null;
  tree: TreeViewResult;
  boundDocumentId: string | null;
}): ReplayAddress {
  const requested = `/${canonicalDocumentPath(input.destination.path)}`;
  const resolved = resolveIn(input.tree, (tree) => {
    const owner = resolveLiveRouteDocument({
      path: requested,
      boundDocumentId: input.boundDocumentId,
      tree,
    });
    return owner.kind === "live" ? owner.file : owner.kind === "pending" ? "held" : null;
  });
  if (resolved.kind !== "found") return resolved;
  if (resolved.value === "held") return { kind: "held" };
  const file = resolved.value;
  const authority = authorityOf(file, input, input.destination.scheme);
  // A chat's uploads are files, never editable text: they have no editor address.
  if (!authority || input.destination.scheme === "uploads") return { kind: "absent" };
  return {
    kind: "found",
    file,
    result: {
      kind: "current",
      document: {
        kind: "available",
        documentId: file.documentId,
        generation: "0",
        authority,
        entry: entryOf(file, input.tree.tree?.root.entryId ?? "", authority),
      },
    },
  } as ReplayAddress;
}

/**
 * The review item's file when live has no view of the document: a page a draft created opens as
 * review, never as a blank live editor.
 */
export function draftOnlyTarget(
  result: DocumentAddressResult | undefined,
  view: "live" | "review",
  draftList: { files: ReviewFileTarget[] | null },
): ReviewFileTarget | undefined {
  if (view !== "review" || !result || result.kind === "unavailable") return undefined;
  const file = draftList.files?.find(
    (candidate) => candidate.documentId === result.document.documentId,
  );
  return file?.draftOnly ? file : undefined;
}
