/** Normalizes the phone route and catalog into the exact document host input. */

import { contextOwner, type ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useCallback, useMemo } from "react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { type ServerContextTab, useContextTabs } from "@/client/stores";
import { routeSelectionDocumentId } from "../context/context-removal-protocol";
import { contextTabFromFile } from "../context/context-tab-from-file";
import { type AddressedDocument, resolveRouteDocumentOwner } from "../context/route-document-owner";
import { useContextRemovalProject } from "../context/use-context-removal-project";
import type { ProjectRouteIssue } from "../routing/ProjectRouteBoundary";
import { contextRouteRequest } from "../routing/project-route";

export type AddressState = "pending" | "failed" | "settled";

/** The address verdict a route issue states: only loading is pending and only error failed. */
export function addressStateOf(issue: ProjectRouteIssue | undefined): AddressState {
  return issue === "loading" ? "pending" : issue === "error" ? "failed" : "settled";
}

export type MobileDocumentRoute = Readonly<{
  requested: boolean;
  scheme: ProjectContextTreeScheme | null;
  path: string | null;
  /** A Work's Scratch route names its owning Work here. */
  workId?: string | null;
  /** A chat's Scratch route names its lineage here, in place of a Work. */
  rootThreadId?: string | null;
  tab: ServerContextTab | null;
  /** Live lacks the document: the tab is built from the address's draft row. */
  draftOnly: boolean;
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
  /** The document the answered address names (`addressedDocument`). */
  addressed?: AddressedDocument | null;
  /** The instance an open installed for a document; its open answer transfers to that instance. */
  installedInstanceOf?: (documentId: string) => string | undefined;
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
      workId: input.workId ?? null,
      rootThreadId: input.rootThreadId ?? null,
      tab: null,
      draftOnly: false,
      catalogResolved: false,
      addressState: "settled",
      isError: false,
      isFetching: false,
    };
  }
  // Identity before path, exactly as the desktop's route owner reads it.
  const rootThreadId = input.rootThreadId ?? undefined;
  const owner = resolveRouteDocumentOwner({
    locator: contextRouteRequest({
      scheme: input.scheme,
      path: input.path,
      workId: input.workId,
      rootThreadId,
    }),
    boundDocumentId: input.boundDocumentId,
    catalog: input.catalog,
    addressed: input.addressed,
  });
  const resolved =
    owner.kind === "live"
      ? (() => {
          const projected = contextTabFromFile(
            input.scheme,
            owner.file,
            contextOwner(input.workId, rootThreadId),
          );
          const tabInstanceId = input.installedInstanceOf?.(owner.file.documentId);
          return tabInstanceId ? { ...projected, tabInstanceId } : projected;
        })()
      : owner.kind === "draft-only" || owner.kind === "addressed"
        ? owner.tab
        : null;
  return {
    requested: true,
    scheme: input.scheme,
    path: input.path,
    workId: input.workId ?? null,
    rootThreadId: input.rootThreadId ?? null,
    tab: resolved?.kind === "new" ? null : resolved,
    draftOnly: owner.kind === "draft-only",
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
  addressed?: AddressedDocument | null;
  addressState?: AddressState;
}): MobileDocumentRoute {
  const requested = input.enabled && input.scheme !== null && input.path !== null;
  const { selection } = useContextRemovalProject(input.projectId);
  const { tabs } = useContextTabs(input.projectId);
  const installedInstanceOf = useCallback(
    (documentId: string) => tabs.find((tab) => tab.documentId === documentId)?.tabInstanceId,
    [tabs],
  );
  const boundDocumentId =
    input.scheme !== null && input.path !== null
      ? routeSelectionDocumentId(selection, {
          scheme: input.scheme,
          path: input.path,
          workId: input.workId ?? undefined,
          rootThreadId: input.rootThreadId ?? undefined,
        })
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
        addressed: input.addressed,
        installedInstanceOf,
        addressState: input.addressState,
        catalog,
        isError,
        isFetching,
      }),
    [
      boundDocumentId,
      input.addressed,
      installedInstanceOf,
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
