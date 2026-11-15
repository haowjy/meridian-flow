import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { RowWord } from "@/components/app/RowWord";
import { workFailureLine } from "./WorkCommandFailureRow";
import type { GoneEntry } from "./work-list-model";

/**
 * The word on a purged Work's row, where the row stays in place: what the failed restore found,
 * and Dismiss. No Restore: the server has nothing to restore.
 */
export function GoneWord({ entry }: { entry: GoneEntry }) {
  const { name } = entry.work;
  const line = entry.failure ? workFailureLine(entry.failure, { name }) : null;
  return (
    <RowWord
      tone="warning"
      word={<Trans>Dismiss</Trans>}
      label={t`Dismiss ${name}`}
      sentence={line?.message ?? t`Gone from Trash.`}
      onAction={line?.onDismiss}
    />
  );
}
