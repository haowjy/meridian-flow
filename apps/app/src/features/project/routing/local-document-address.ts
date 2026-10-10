/** Warm exact content resolves readable routes without waiting for remote address lookup. */

import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type {
  DocumentAddressResult,
  ProjectContextIdentityResolution,
} from "@meridian/contracts/protocol";
import type { CatalogContextView, CatalogFile } from "@/client/query/context-catalog-projection";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import type { ContextRouteSelection } from "../context/context-removal-protocol";
import { resolveLiveRouteDocument } from "../context/route-document-owner";
import type { ProjectAddress, ProjectDestination } from "./project-address";
import { workSelectionFor } from "./project-address-resolution";

type DocumentDestination = Extract<ProjectDestination, { kind: "document" }>;
type AvailableDocumentAuthority = Extract<
  ProjectContextIdentityResolution,
  { kind: "available" }
>["authority"];

export function canonicalDocumentPath(path: string): string {
  return path.replace(/^\/+/, "");
}

/**
 * Whether the address already names this document, in the Work the target
 * resolves to. Open requests carry no Work until the route boundary resolves
 * it, so an unresolved target never matches. When both sides know the document,
 * identity alone decides: a reused path never makes two documents one. The path
 * is only the fallback while either identity is unresolved.
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
  noWorkId: string | null,
  /** The document the address resolved to, absent while it is still resolving. */
  addressDocumentId?: string,
  /** The Editor's resolved Work: the one an address that names none (a copied live URL) shows. */
  editorWorkId?: string | null,
): boolean {
  const destination = address.destination;
  if (destination.kind !== "document") return false;
  // A chat's Scratch is owned by its lineage; a Work's Scratch by its Work.
  if (target.rootThreadId !== address.lineage) return false;
  if (target.rootThreadId !== undefined)
    return sameDocument(destination, target, addressDocumentId);
  const work = workSelectionFor(destination, target.workId, noWorkId);
  // An address with no `?work=` is not a different Work from No Work: it shows the Editor's own.
  const addressWork =
    address.work.kind === "absent" && editorWorkId
      ? workSelectionFor(destination, editorWorkId, noWorkId)
      : address.work;
  if (
    work.kind !== addressWork.kind ||
    (work.kind === "id" && !(addressWork.kind === "id" && addressWork.id === work.id))
  )
    return false;
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

/**
 * The document a route holds by continuity: bound to this route's locator in the Editor's
 * context (its selected Work, named or not, whatever the document's own namespace) and
 * actually admitted by this surface. A binding inferred from a cached tab before the server
 * answered is a guess, not continuity, and must not override a fresh lookup.
 */
export function routeContinuityDocumentId(input: {
  selection: ContextRouteSelection;
  admittedDocumentId: string | null;
  destination: DocumentDestination | null;
  editorWorkId: string | null;
  /** The lineage a Scratch address names. */
  rootThreadId?: string;
}): string | null {
  const { selection, destination } = input;
  if (
    !destination ||
    selection.status !== "bound" ||
    selection.identity.kind !== "server" ||
    selection.identity.documentId !== input.admittedDocumentId ||
    selection.locator.scheme !== destination.scheme ||
    canonicalDocumentPath(selection.locator.path) !== canonicalDocumentPath(destination.path) ||
    selection.locator.workId !== input.editorWorkId ||
    selection.locator.rootThreadId !== input.rootThreadId
  )
    return null;
  return selection.identity.documentId;
}

export function resolveLocalDocumentAddress(
  projectId: string,
  destination: DocumentDestination,
  workId: string | null,
  catalog: CatalogContextView | null,
  /** The document the route is bound to: where the URL names a path the document has left, it is found by identity. */
  boundDocumentId: string | null = null,
  /** The lineage a Scratch address names, in place of a Work. */
  rootThreadId: string | null = null,
): { result: DocumentAddressResult; file: CatalogFile; bound: boolean } | undefined {
  if (!catalog) return undefined;
  const requested = `/${canonicalDocumentPath(destination.path)}`;
  // The document the route is bound to is the route's document wherever its placement goes:
  // an unconfirmed move of it or a folder above it, that move's rollback, or another document
  // taking a path it holds or left. The path is its current label, and admission repairs the
  // URL to it. It is already open, so it needs no exact local content, and the server's answer
  // for a path in flux does not outrank it. A bound document the catalog does not list yet is
  // never answered by the path's occupant (the shared route-document order).
  const owner = resolveLiveRouteDocument({ path: requested, boundDocumentId, catalog });
  if (owner.kind !== "live") return undefined;
  const { file } = owner;
  const bound = owner.byIdentity ? file : null;
  // A document under the writer's own unconfirmed move is likewise a known server document.
  if (
    file.kind !== "file" ||
    !file.editable ||
    !(file.localContent || file.placementPending || bound)
  )
    return undefined;
  const entry = catalog.normalized.entries.get(file.documentId);
  if (entry?.kind !== "file") return undefined;
  let authority: AvailableDocumentAuthority;
  if (entry.scope.kind === "project") authority = entry.scope;
  else if (entry.scope.kind === "user") authority = entry.scope;
  else if (entry.scope.kind === "lineage") {
    const uri = parseUnifiedContextUri(file.uri);
    if (
      rootThreadId !== entry.scope.rootThreadId ||
      !uri.ok ||
      uri.value.authority.kind !== "lineage"
    )
      return undefined;
    authority = {
      kind: "lineage",
      projectId,
      rootThreadId: entry.scope.rootThreadId,
      rootThreadRef: uri.value.authority.rootThreadRef,
    };
  } else {
    if (!workId || workId !== entry.scope.workId) return undefined;
    const uri = parseUnifiedContextUri(file.uri);
    if (!uri.ok || uri.value.authority.kind === "contextual") return undefined;
    authority = {
      kind: "work",
      projectId,
      workId: entry.scope.workId,
      workSlug: uri.value.authority.kind === "work" ? uri.value.authority.workSlug : null,
    };
  }
  return {
    file,
    bound: bound !== null,
    result: {
      kind: "current",
      document: {
        kind: "available",
        documentId: file.documentId,
        generation: "0",
        authority,
        entry,
      },
    },
  };
}

/** Local content masks failure, but a successful server address owns canonical repair. */
export function reconcileDocumentAddress(
  local: ReturnType<typeof resolveLocalDocumentAddress>,
  remote: DocumentAddressResult | undefined,
): { result: DocumentAddressResult | undefined; localFile: CatalogFile | undefined } {
  // The route's open document outranks whatever the server says about the path it holds or left.
  if (local?.bound) return { result: local.result, localFile: local.file };
  if (remote && remote.kind !== "unavailable") {
    // While the writer's own move is unconfirmed, the path it gave this document is its
    // address; a server alias for that path only remembers where the document used to be.
    if (
      remote.kind === "alias" &&
      local?.file.placementPending &&
      local.file.documentId === remote.document.documentId
    )
      return { result: local.result, localFile: local.file };
    return {
      result: remote,
      localFile: local?.file.documentId === remote.document.documentId ? local.file : undefined,
    };
  }
  if (local) return { result: local.result, localFile: local.file };
  return { result: remote, localFile: undefined };
}

/** Retain exact local ownership while successful server metadata owns the locator. */
export function mergeLocalResourceState(
  canonical: CatalogFile,
  local: CatalogFile | undefined,
): CatalogFile {
  if (!local || local.documentId !== canonical.documentId) return canonical;
  return {
    ...canonical,
    ...(local.resourceHandle ? { resourceHandle: local.resourceHandle } : {}),
    ...(local.resourceState ? { resourceState: local.resourceState } : {}),
    ...(local.resourceOrigin ? { resourceOrigin: local.resourceOrigin } : {}),
    ...(local.localContent ? { localContent: local.localContent } : {}),
    ...(local.namespaceFailure ? { namespaceFailure: local.namespaceFailure } : {}),
    ...(local.namespaceRepairName ? { namespaceRepairName: local.namespaceRepairName } : {}),
    ...(local.namespaceFailureAt === undefined
      ? {}
      : { namespaceFailureAt: local.namespaceFailureAt }),
  };
}

/**
 * The server resolves every tree node, including a new document that only a
 * pending draft proposes and one whose draft was discarded. The live manifest
 * lists what can open live. A manuscript document missing from it has no live
 * view: its pending new-document draft opens as review, and with no such draft
 * the address is unavailable. Never a blank live editor.
 *
 * Absence concludes "unavailable" only on an authoritative read: the catalog is
 * settled (a stored checkpoint stays "complete" while its refresh is in flight)
 * and the drafts were read. A read still in flight is `pending`; a read that
 * failed is `failed`, never evidence of absence and never an endless wait. A tab
 * already open live (an Apply promoted it) is never second-guessed by a lagging catalog.
 */
export type GatedLiveView =
  | { outcome: "ready"; result: DocumentAddressResult | undefined; draftOnly?: ReviewFileTarget }
  | { outcome: "pending" | "failed"; result: undefined };

export function gateLiveView(
  result: DocumentAddressResult | undefined,
  scheme: string,
  manifest: {
    catalog: CatalogContextView | null;
    isComplete: boolean;
    isFetching: boolean;
    isError: boolean;
  },
  drafts: { status: string; files: ReviewFileTarget[] | null },
  hasLiveTab: (documentId: string) => boolean,
): GatedLiveView {
  if (scheme !== "manuscript" || !result || result.kind === "unavailable")
    return { outcome: "ready", result };
  const documentId = result.document.documentId;
  if (hasLiveTab(documentId) || manifest.catalog?.normalized.entries.has(documentId))
    return { outcome: "ready", result };
  if (manifest.isError || drafts.status === "error")
    return { outcome: "failed", result: undefined };
  const settled = manifest.isComplete && !manifest.isFetching;
  if (!settled || drafts.status === "loading") return { outcome: "pending", result: undefined };
  const group = drafts.files?.find((candidate) => candidate.documentId === documentId);
  if (group?.isNewDocument) return { outcome: "ready", result, draftOnly: group };
  return { outcome: "ready", result: { kind: "unavailable" } };
}
