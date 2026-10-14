/**
 * What an import shows on the tree's and the phone listing's rows: the run's mark,
 * the warning for a file that failed to arrive, and the pending file's Retry. The
 * desktop tree and the phone listing lay these out on their own rows.
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ImportEntryReason } from "@meridian/contracts";
import { failureSentence } from "@/features/import/reason-copy";
import type { ImportRowInfo } from "@/features/import/tree-rows";
import { useImportRowActions } from "@/features/import/use-import-row-actions";
import { FailureMark } from "./FailureMark";
import { ImportRunMark } from "./ImportRunMark";

/** The warning on a file the import could not bring in. */
export function ImportFailureMark({ reason }: { reason: ImportEntryReason | null }) {
  return <FailureMark message={t`Couldn't import this file. ${failureSentence(reason)}`} />;
}

/** The status of a row only the import draws: its run mark, and a failed file's warning and Retry. */
export function PendingRowStatus({
  status,
  retryClassName,
}: {
  status: ImportRowInfo;
  retryClassName: string;
}) {
  const actions = useImportRowActions(status);
  const failure = status.failure;
  return (
    <>
      <ImportRunMark info={status} />
      {failure ? (
        <>
          <ImportFailureMark reason={failure.reason} />
          {actions?.retry ? (
            <button
              type="button"
              onClick={actions.retry}
              className={`focus-ring text-button ${retryClassName}`}
            >
              <Trans>Retry</Trans>
            </button>
          ) : null}
        </>
      ) : null}
    </>
  );
}
