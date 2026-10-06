/** Normalizes the phone route and catalog into the exact document host input. */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { type ContextTab, type ServerContextTab, useContextTabs } from "@/client/stores";
import { resolveWorkspaceRoute } from "../context/context-route-workspace-owner";
import { contextTabFromFile } from "../context/context-tab-from-file";
import { useContextRemovalProject } from "../context/use-context-removal-project";

export type MobileDocumentRoute = Readonly<{
  requested: boolean;
  scheme: ProjectContextTreeScheme | null;
  path: string | null;
  tab: ServerContextTab | null;
  catalogResolved: boolean;
  isError: boolean;
  isFetching: boolean;
}>;

export function resolveMobileDocumentRoute(input: {
  enabled: boolean;
  scheme: ProjectContextTreeScheme | null;
  path: string | null;
  workId: string | null;
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
      tab: null,
      catalogResolved: false,
      isError: false,
      isFetching: false,
    };
  }
  // The bound document is the route's document wherever its placement goes, even when another
  // document now holds the path the URL names.
  const bound = input.boundDocumentId
    ? (input.catalog?.findDocument(input.boundDocumentId) ?? null)
    : null;
  const found = input.catalog?.findPath(input.path);
  const file = bound ?? (found?.kind === "file" ? found : null);
  const resolved =
    file && input.workId ? contextTabFromFile(input.scheme, file, input.workId) : null;
  return {
    requested: true,
    scheme: input.scheme,
    path: input.path,
    tab:
      resolved?.kind === "new" ? null : (resolved ?? draftOnlyTab(input, input.scheme, input.path)),
    catalogResolved: input.catalog !== null,
    isError: input.isError,
    isFetching: input.isFetching,
  };
}

/** The draft-only review tab that owns this route, by identity before locator. */
function draftOnlyTab(
  input: {
    workId: string | null;
    boundDocumentId?: string | null;
    workspaceTabs?: readonly ContextTab[];
  },
  scheme: ProjectContextTreeScheme,
  path: string,
): ServerContextTab | null {
  if (!input.workId) return null;
  const owner = resolveWorkspaceRoute({
    tabs: (input.workspaceTabs ?? []).filter(
      (tab) => tab.kind !== "new" && tab.draftOnly === true && tab.reviewWorkId === input.workId,
    ),
    selectedDocumentId: undefined,
    locator: { scheme, path, workId: input.workId },
    boundDocumentId: input.boundDocumentId,
  });
  return owner.kind === "owner" && owner.tab.kind !== "new" ? owner.tab : null;
}

export function useMobileDocumentRoute(input: {
  enabled: boolean;
  projectId: string;
  scheme: ProjectContextTreeScheme | null;
  path: string | null;
  workId: string | null;
}): MobileDocumentRoute {
  const requested = input.enabled && input.scheme !== null && input.path !== null;
  const { tabs: workspaceTabs } = useContextTabs(input.projectId);
  const { selection } = useContextRemovalProject(input.projectId);
  const boundDocumentId =
    selection.status === "bound" &&
    selection.identity.kind === "server" &&
    selection.locator.scheme === input.scheme &&
    selection.locator.path === input.path &&
    selection.locator.workId === input.workId
      ? selection.identity.documentId
      : null;
  const { catalog, isError, isFetching } = useContextCatalogView(
    input.projectId,
    input.scheme ?? "kb",
    { enabled: requested, workId: input.workId },
  );
  return useMemo(
    () =>
      resolveMobileDocumentRoute({
        enabled: input.enabled,
        scheme: input.scheme,
        path: input.path,
        workId: input.workId,
        boundDocumentId,
        workspaceTabs,
        catalog,
        isError,
        isFetching,
      }),
    [
      boundDocumentId,
      workspaceTabs,
      catalog,
      input.enabled,
      input.path,
      input.scheme,
      input.workId,
      isError,
      isFetching,
    ],
  );
}
