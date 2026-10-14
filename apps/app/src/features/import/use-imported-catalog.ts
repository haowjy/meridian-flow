/** The tree's view of imports: rows layered over a scheme's catalog. */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useEffect, useMemo } from "react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useImportsSnapshot, useOptionalImports } from "./ImportProvider";
import { withImportRows } from "./tree-projection";

export function useImportedCatalog(
  catalog: CatalogContextView | null,
  scheme: ProjectContextTreeScheme,
): { catalog: CatalogContextView | null } {
  const imports = useOptionalImports();
  const snapshot = useImportsSnapshot(imports?.coordinator ?? null);
  const projected = useMemo(() => {
    if (!catalog || snapshot.states.length === 0) return { catalog, handedOff: null };
    const layered = withImportRows(catalog, scheme, snapshot.states);
    return { catalog: layered.view, handedOff: layered.handedOff };
  }, [catalog, scheme, snapshot]);
  const coordinator = imports?.coordinator;
  // The rows already went from this render; recording it keeps them gone after a move or delete.
  useEffect(() => {
    if (!coordinator || !projected.handedOff) return;
    for (const [importId, keys] of projected.handedOff) coordinator.handOff(importId, keys);
  }, [coordinator, projected.handedOff]);
  return { catalog: projected.catalog };
}
