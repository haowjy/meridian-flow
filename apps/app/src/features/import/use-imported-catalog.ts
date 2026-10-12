/** The tree's view of imports: rows layered over a scheme's catalog, status rows by folder. */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useMemo, useSyncExternalStore } from "react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useImportsSnapshot, useOptionalImports } from "./ImportProvider";
import type { RevealRequest } from "./import-coordinator";
import { statusParents } from "./placements";
import { withImportRows } from "./tree-projection";

export function useImportedCatalog(
  catalog: CatalogContextView | null,
  scheme: ProjectContextTreeScheme,
): { catalog: CatalogContextView | null; statusByParent: ReadonlyMap<string, readonly string[]> } {
  const imports = useOptionalImports();
  const snapshot = useImportsSnapshot(imports?.coordinator ?? null);
  return useMemo(() => {
    if (!catalog || snapshot.states.length === 0)
      return { catalog, statusByParent: new Map<string, readonly string[]>() };
    return {
      catalog: withImportRows(catalog, scheme, snapshot.states),
      statusByParent: statusParents(catalog, scheme, snapshot.states),
    };
  }, [catalog, scheme, snapshot]);
}

const noReveal = () => () => {};
const none = () => null;

/** The latest "show this folder" request for a scheme, from the report's Open buttons. */
export function useRevealRequest(scheme: ProjectContextTreeScheme): RevealRequest | null {
  const imports = useOptionalImports();
  const request = useSyncExternalStore(
    imports?.coordinator.subscribeReveal ?? noReveal,
    imports?.coordinator.getReveal ?? none,
    none,
  );
  return request?.scheme === scheme ? request : null;
}
