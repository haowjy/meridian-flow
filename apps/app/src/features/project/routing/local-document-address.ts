/** Warm exact content resolves readable routes without waiting for remote address lookup. */

import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type {
  DocumentAddressResult,
  ProjectContextIdentityResolution,
} from "@meridian/contracts/protocol";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import type { CatalogContextView, CatalogFile } from "@/client/query/context-catalog-projection";
import { pendingReviewDraft, type ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import type { ProjectAddress, ProjectDestination } from "./project-address";
import type { ContextRouteTarget } from "./project-route";

type DocumentDestination = Extract<ProjectDestination, { kind: "document" }>;
type AvailableDocumentAuthority = Extract<
  ProjectContextIdentityResolution,
  { kind: "available" }
>["authority"];

export function canonicalDocumentPath(path: string): string {
  return path.replace(/^\/+/, "");
}

export function projectAddressMatchesContextTarget(
  address: ProjectAddress,
  target: ContextRouteTarget,
): boolean {
  return (
    address.destination.kind === "document" &&
    address.destination.scheme === target.scheme &&
    canonicalDocumentPath(address.destination.path) === canonicalDocumentPath(target.path) &&
    (target.workId === null
      ? address.work.kind === "none"
      : address.work.kind === "id" && address.work.id === target.workId)
  );
}

export function resolveLocalDocumentAddress(
  projectId: string,
  destination: DocumentDestination,
  workId: ParsedRequestId | null,
  catalog: CatalogContextView | null,
): { result: DocumentAddressResult; file: CatalogFile } | undefined {
  if (!catalog) return undefined;
  const file = catalog.findPath(`/${canonicalDocumentPath(destination.path)}`);
  if (file?.kind !== "file" || !file.editable || !file.localContent) return undefined;
  const entry = catalog.normalized.entries.get(file.documentId);
  if (entry?.kind !== "file") return undefined;
  let authority: AvailableDocumentAuthority;
  if (entry.scope.kind === "project") authority = entry.scope;
  else if (entry.scope.kind === "user") authority = entry.scope;
  else {
    if (!workId || workId !== entry.scope.workId) return undefined;
    const uri = parseUnifiedContextUri(file.uri);
    if (!uri.ok || uri.value.authority.kind !== "work") return undefined;
    authority = {
      kind: "work",
      projectId,
      workId: entry.scope.workId,
      workSlug: uri.value.authority.workSlug,
    };
  }
  return {
    file,
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
  if (remote && remote.kind !== "unavailable") {
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
  };
}

/**
 * The server resolves every tree node, including a new document that only a
 * pending draft proposes and one whose draft was discarded. The live manifest
 * lists what can open live. A manuscript document missing from it has no live
 * view: its pending new-document draft opens as review, and with no such draft
 * the address is unavailable. Never a blank live editor.
 */
export function gateLiveView(
  result: DocumentAddressResult | undefined,
  scheme: string,
  manifest: { catalog: CatalogContextView | null; isComplete: boolean },
  drafts: { status: string; groups: ThreadDraftGroup[] | null },
): { result: DocumentAddressResult | undefined; draftOnly?: ThreadDraftGroup } {
  if (scheme !== "manuscript" || !result || result.kind === "unavailable") return { result };
  const documentId = result.document.documentId;
  if (manifest.catalog?.normalized.entries.has(documentId)) return { result };
  // Absence is only proof once the manifest is complete and the drafts are read.
  if (!manifest.isComplete || drafts.status === "loading") return { result: undefined };
  const group = drafts.groups?.find((candidate) => candidate.documentId === documentId);
  if (group && pendingReviewDraft(group)?.isNewDocument) return { result, draftOnly: group };
  return { result: { kind: "unavailable" } };
}
