/**
 * What a row can do about its import: Retry a failed file here (or fall back to
 * Continue import), or Try again / Discard an import whose plan did not start.
 */
import { useCallback, useMemo } from "react";
import type { ImportRowInfo } from "@/client/query/context-catalog-projection";
import { useOptionalImports } from "./ImportProvider";

export type ImportRowActions = {
  retry?: () => void;
  tryAgain?: () => void;
  discard?: () => void;
};

export function useImportRowActions(info: ImportRowInfo | undefined): ImportRowActions | null {
  const imports = useOptionalImports();
  const failure = info?.failure;
  const notStarted = info?.notStarted;
  const retry = useCallback(() => {
    if (!failure || !imports) return;
    if (failure.canRetry) imports.coordinator.retry(failure.importId, [failure.entryId]);
    else imports.openContinue(failure.importId);
  }, [failure, imports]);
  return useMemo(() => {
    if (!imports) return null;
    if (notStarted)
      return {
        tryAgain: () => imports.coordinator.tryAgain(notStarted.importId),
        discard: () => void imports.coordinator.discard(notStarted.importId),
      };
    return failure ? { retry } : null;
  }, [imports, failure, notStarted, retry]);
}
