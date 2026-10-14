/**
 * What a row can do about its import: Retry a failed file here (or fall back to
 * Continue import), Try again / Discard an import whose plan did not start, and,
 * from the run mark, Retry failed files, Continue import and Stop.
 */
import { useMemo } from "react";
import type { ImportRowInfo } from "@/client/query/context-catalog-projection";
import { useOptionalImports } from "./ImportProvider";

export type ImportRowActions = {
  retry?: () => void;
  tryAgain?: () => void;
  discard?: () => void;
  /** Send every failed file this tab holds again. */
  retryFailed?: () => void;
  continueImport?: () => void;
  stop?: () => void;
};

export function useImportRowActions(info: ImportRowInfo | undefined): ImportRowActions | null {
  const imports = useOptionalImports();
  const failure = info?.failure;
  const notStarted = info?.notStarted;
  const run = info?.run;
  return useMemo(() => {
    if (!imports) return null;
    const { coordinator } = imports;
    if (notStarted)
      return {
        tryAgain: () => coordinator.tryAgain(notStarted.importId),
        discard: () => void coordinator.discard(notStarted.importId),
      };
    if (run)
      return {
        retryFailed: () => void coordinator.retry(run.importId),
        continueImport: () => imports.openContinue(run.importId),
        stop: () => imports.openStop(run.importId),
      };
    if (!failure) return null;
    return {
      retry: () => {
        if (failure.canRetry) coordinator.retry(failure.importId, [failure.entryId]);
        else imports.openContinue(failure.importId);
      },
    };
  }, [imports, failure, notStarted, run]);
}
