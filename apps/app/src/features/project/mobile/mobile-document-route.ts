/** Normalizes the phone route and catalog into the exact document host input. */

import { contextOwner, type ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { type ContextTab, type ServerContextTab, useContextTabs } from "@/client/stores";
import { contextTabFromFile } from "../context/context-tab-from-file";
import { resolveRouteDocumentOwner } from "../context/route-document-owner";
import { useContextRemovalProject } from "../context/use-context-removal-project";
import type { ProjectRouteIssue } from "../routing/ProjectRouteBoundary";

export type AddressState = "pending" | "failed" | "settled";

/** The address verdict a route issue states: only loading is pending and only error failed. */
export function addressStateOf(issue: ProjectRouteIssue | undefined): AddressState {
  return issue === "loading" ? "pending" : issue === "error" ? "failed" : "settled";
}

export type MobileDocumentRoute = Readonly<{
  requested: boolean;
  scheme: ProjectContextTreeScheme | null;
  path: string | null;
  /** A chat's Scratch route names its lineage here, in place of a Work. */
  rootThreadId?: string | null;
  tab: ServerContextTab | null;
  catalogResolved: boolean;
  /**
   * The readable address's own verdict on its document. It is the only evidence for or
   * against a document the live catalog lacks, such as a pending new-document draft's, so
   * absence proves nothing until the address is `settled`. `failed` is a verdict the route
   * boundary shows with its retry; the host neither waits on it nor rejects the route.
   */
  addressState: AddressState;
  isError: boolean;
  isFetching: boolean;
}>;

export function resolveMobileDocumentRoute(input: {
  enabled: boolean;
  scheme: ProjectContextTreeScheme | null;
  path: string | null;
  workId: string | null;
  rootThreadId?: string | null;
  /**
   * The document this route is bound to. A rename of it or a folder above it (or that
   * rename's rollback) changes its projected path at once, so the host finds it by identity
   * while the readable route repairs the URL to the same projected path.
   */
  boundDocumentId?: string | null;
  /**
   * The Editor workspace's tabs. Only a draft-only review tab is read from it: a pending
   * new-document draft is not in the live catalog, so the tab the review launch installed
   * is the document's admission.
   */
  workspaceTabs?: readonly ContextTab[];
  addressState?: AddressState;
  catalog: CatalogContextView | null;
  isError: boolean;
  isFetching: boolean;
}): MobileDocumentRoute {
  const requested = input.enabled && input.scheme !== null && input.path !== null;
  if (!requested || !input.scheme || !input.path) {
    return {
      requested: false,
      scheme: input.scheme,
      path: input.path,
      rootThreadId: input.rootThreadId ?? null,
      tab: null,
      catalogResolved: false,
      addressState: "settled",
      isError: false,
      isFetching: false,
    };
  }
  // Identity before path, exactly as the desktop's route owner reads it.
  const rootThreadId = input.rootThreadId ?? undefined;
  const owner = input.workId
    ? resolveRouteDocumentOwner({
        locator: { scheme: input.scheme, path: input.path, workId: input.workId, rootThreadId },
        boundDocumentId: input.boundDocumentId,
        catalog: input.catalog,
        workspaceTabs: input.workspaceTabs,
      })
    : { kind: "absent" as const };
  const resolved =
    owner.kind === "live" && input.workId
      ? contextTabFromFile(input.scheme, owner.file, contextOwner(input.workId, rootThreadId))
      : owner.kind === "draft-only"
        ? owner.tab
        : null;
  return {
    requested: true,
    scheme: input.scheme,
    path: input.path,
    rootThreadId: input.rootThreadId ?? null,
    tab: resolved?.kind === "new" ? null : resolved,
    catalogResolved: input.catalog !== null,
    addressState: input.addressState ?? "settled",
    isError: input.isError,
    isFetching: input.isFetching,
  };
}

export function useMobileDocumentRoute(input: {
  enabled: boolean;
  projectId: string;
  scheme: ProjectContextTreeScheme | null;
  path: string | null;
  workId: string | null;
  rootThreadId?: string | null;
  addressState?: AddressState;
}): MobileDocumentRoute {
  const requested = input.enabled && input.scheme !== null && input.path !== null;
  const { tabs: workspaceTabs } = useContextTabs(input.projectId);
  const { selection } = useContextRemovalProject(input.projectId);
  const boundDocumentId =
    selection.status === "bound" &&
    selection.identity.kind === "server" &&
    selection.locator.scheme === input.scheme &&
    selection.locator.path === input.path &&
    selection.locator.workId === input.workId &&
    selection.locator.rootThreadId === (input.rootThreadId ?? undefined)
      ? selection.identity.documentId
      : null;
  const { catalog, isError, isFetching } = useContextCatalogView(
    input.projectId,
    input.scheme ?? "kb",
    { enabled: requested, ...contextOwner(input.workId, input.rootThreadId) },
  );
  return useMemo(
    () =>
      resolveMobileDocumentRoute({
        enabled: input.enabled,
        scheme: input.scheme,
        path: input.path,
        workId: input.workId,
        rootThreadId: input.rootThreadId,
        boundDocumentId,
        workspaceTabs,
        addressState: input.addressState,
        catalog,
        isError,
        isFetching,
      }),
    [
      boundDocumentId,
      workspaceTabs,
      catalog,
      input.addressState,
      input.enabled,
      input.path,
      input.scheme,
      input.workId,
      input.rootThreadId,
      isError,
      isFetching,
    ],
  );
}
