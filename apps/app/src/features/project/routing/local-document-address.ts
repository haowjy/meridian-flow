/** Warm exact content resolves readable routes without waiting for remote address lookup. */

import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type {
  DocumentAddressResult,
  ProjectContextIdentityResolution,
} from "@meridian/contracts/protocol";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import type { CatalogContextView, CatalogFile } from "@/client/query/context-catalog-projection";
import type { ProjectDestination } from "./project-address";

type DocumentDestination = Extract<ProjectDestination, { kind: "document" }>;
type AvailableDocumentAuthority = Extract<
  ProjectContextIdentityResolution,
  { kind: "available" }
>["authority"];

export function resolveLocalDocumentAddress(
  projectId: string,
  destination: DocumentDestination,
  workId: ParsedRequestId | null,
  catalog: CatalogContextView | null,
): { result: DocumentAddressResult; file: CatalogFile } | undefined {
  if (!catalog) return undefined;
  const file = catalog.findPath(`/${destination.path.replace(/^\/+/, "")}`);
  if (file?.kind !== "file" || !file.editable || !file.localContent) return undefined;
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
