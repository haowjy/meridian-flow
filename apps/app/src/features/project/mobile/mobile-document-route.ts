/** Normalizes the phone route and catalog into the exact document host input. */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import type { ServerContextTab } from "@/client/stores";
import { contextTabFromFile } from "../context/context-tab-from-file";

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
  const found = input.catalog?.findPath(input.path);
  const file = found?.kind === "file" ? found : null;
  return {
    requested: true,
    scheme: input.scheme,
    path: input.path,
    tab: file ? contextTabFromFile(input.scheme, file, input.workId) : null,
    catalogResolved: input.catalog !== null,
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
}): MobileDocumentRoute {
  const requested = input.enabled && input.scheme !== null && input.path !== null;
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
        catalog,
        isError,
        isFetching,
      }),
    [catalog, input.enabled, input.path, input.scheme, input.workId, isError, isFetching],
  );
}

export function mobileEditableDocumentId(route: MobileDocumentRoute): string | null {
  return route.tab?.editable ? route.tab.documentId : null;
}
