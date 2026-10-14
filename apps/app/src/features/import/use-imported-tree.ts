/** The tree's view of imports: rows layered over a scheme's catalog. */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useImportsSnapshot, useOptionalImports } from "./ImportProvider";
import { withImportRows } from "./tree-projection";
import { type ImportedTree, plainTree } from "./tree-rows";

export function useImportedTree(
  catalog: CatalogContextView | null,
  scheme: ProjectContextTreeScheme,
): ImportedTree | null {
  const snapshot = useImportsSnapshot(useOptionalImports()?.coordinator ?? null);
  return useMemo(
    () =>
      !catalog
        ? null
        : snapshot.imports.length > 0
          ? withImportRows(catalog, scheme, snapshot.imports)
          : plainTree(catalog),
    [catalog, scheme, snapshot],
  );
}
