/** Warm exact content resolves readable routes without waiting for remote address lookup. */

import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type {
  DocumentAddressResult,
  ProjectContextIdentityResolution,
} from "@meridian/contracts/protocol";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import type { CatalogContextView, CatalogFile } from "@/client/query/context-catalog-projection";
import { pendingReviewDraft, type ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import type { ContextRouteSelection } from "../context/context-removal-protocol";
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
 * Whether the address already names this document: same scheme and path in the
 * Work the target resolves to. Open requests carry no Work until the route
 * boundary resolves it, so an unresolved target never matches.
 */
export function projectAddressMatchesContextTarget(
  address: ProjectAddress,
  target: { scheme: string; path: string; workId?: string },
  noWorkId: string | null,
): boolean {
  const destination = address.destination;
  if (
    destination.kind !== "document" ||
    destination.scheme !== target.scheme ||
    canonicalDocumentPath(destination.path) !== canonicalDocumentPath(target.path)
  )
    return false;
  const work = workSelectionFor(destination, target.workId, noWorkId);
  return (
    work.kind === address.work.kind &&
    (work.kind !== "id" || (address.work.kind === "id" && address.work.id === work.id))
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
}): string | null {
  const { selection, destination } = input;
  if (
    !destination ||
    selection.status !== "bound" ||
    selection.identity.kind !== "server" ||
    selection.identity.documentId !== input.admittedDocumentId ||
    selection.locator.scheme !== destination.scheme ||
    canonicalDocumentPath(selection.locator.path) !== canonicalDocumentPath(destination.path) ||
    selection.locator.workId !== input.editorWorkId
  )
    return null;
  return selection.identity.documentId;
}

export function resolveLocalDocumentAddress(
  projectId: string,
  destination: DocumentDestination,
  workId: ParsedRequestId | null,
  catalog: CatalogContextView | null,
  /** The document the route is bound to: where the URL names a path the document has left, it is found by identity. */
  boundDocumentId: string | null = null,
): { result: DocumentAddressResult; file: CatalogFile; bound: boolean } | undefined {
  if (!catalog) return undefined;
  const requested = `/${canonicalDocumentPath(destination.path)}`;
  // The document the route is bound to is the route's document wherever its placement goes:
  // an unconfirmed move of it or a folder above it, that move's rollback, or another document
  // taking a path it holds or left. The path is its current label, and admission repairs the
  // URL to it. It is already open, so it needs no exact local content, and the server's answer
  // for a path in flux does not outrank it.
  const bound = boundDocumentId ? (catalog.findDocument(boundDocumentId) ?? null) : null;
  const file = bound ?? catalog.findPath(requested);
  // A document under the writer's own unconfirmed move is likewise a known server document.
  if (
    file?.kind !== "file" ||
    !file.editable ||
    !(file.localContent || file.placementPending || bound)
  )
    return undefined;
  const entry = catalog.normalized.entries.get(file.documentId);
  if (entry?.kind !== "file") return undefined;
  let authority: AvailableDocumentAuthority;
  if (entry.scope.kind === "project") authority = entry.scope;
  else if (entry.scope.kind === "user") authority = entry.scope;
  else {
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
 * and the drafts were read. Anything less is still loading. A tab already open
 * live (an Apply promoted it) is never second-guessed by a lagging catalog.
 */
export function gateLiveView(
  result: DocumentAddressResult | undefined,
  scheme: string,
  manifest: {
    catalog: CatalogContextView | null;
    isComplete: boolean;
    isFetching: boolean;
    isError: boolean;
  },
  drafts: { status: string; groups: ThreadDraftGroup[] | null },
  hasLiveTab: (documentId: string) => boolean,
): { result: DocumentAddressResult | undefined; draftOnly?: ThreadDraftGroup } {
  if (scheme !== "manuscript" || !result || result.kind === "unavailable") return { result };
  const documentId = result.document.documentId;
  if (hasLiveTab(documentId) || manifest.catalog?.normalized.entries.has(documentId))
    return { result };
  const settled = manifest.isComplete && !manifest.isFetching && !manifest.isError;
  if (!settled || drafts.status === "loading" || drafts.status === "error")
    return { result: undefined };
  const group = drafts.groups?.find((candidate) => candidate.documentId === documentId);
  if (group && pendingReviewDraft(group)?.isNewDocument) return { result, draftOnly: group };
  return { result: { kind: "unavailable" } };
}
