/** What a row can do about its import: Retry a failed file here, or fall back to Continue import. */
import { useCallback } from "react";
import type { ImportRowInfo } from "@/client/query/context-catalog-projection";
import { useOptionalImports } from "./ImportProvider";

export function useImportRowActions(failure: ImportRowInfo["failure"] | undefined) {
  const imports = useOptionalImports();
  const retry = useCallback(() => {
    if (!failure || !imports) return;
    if (failure.canRetry) imports.coordinator.retry(failure.importId, [failure.entryId]);
    else imports.openContinue(failure.importId);
  }, [failure, imports]);
  return failure && imports ? { retry } : null;
}
