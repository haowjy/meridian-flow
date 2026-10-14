/** The tree's view of imports: rows layered over a scheme's catalog. */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useImportsSnapshot, useOptionalImports } from "./ImportProvider";
import { withImportRows } from "./tree-projection";

export function useImportedCatalog(
  catalog: CatalogContextView | null,
  scheme: ProjectContextTreeScheme,
): CatalogContextView | null {
  const snapshot = useImportsSnapshot(useOptionalImports()?.coordinator ?? null);
  return useMemo(
    () =>
      catalog && snapshot.imports.length > 0
        ? withImportRows(catalog, scheme, snapshot.imports)
        : catalog,
    [catalog, scheme, snapshot],
  );
}
