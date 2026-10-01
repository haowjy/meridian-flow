/**
 * A Work command the server refused, as the Work list, the Work band and the
 * phone top bar show it: what failed, Retry where it can help, and Dismiss.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { WORK_DELETE_RETENTION_DAYS } from "@meridian/contracts/works";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { HttpResponseError } from "@/client/api/http-client";
import type { WorkCommandFailure } from "@/client/query/work-command-selectors";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { IconButton } from "@/components/ui/icon-button";

/** The commands whose failure stays on the Work until the writer acts on it. */
export const WORK_ROW_OPERATIONS = ["archive", "unarchive", "delete", "restore"] as const;

export type WorkRowFailure = WorkCommandFailure<(typeof WORK_ROW_OPERATIONS)[number]>;

const messages: { [Op in WorkRowFailure["operation"]]: () => string } = {
  archive: () => t`Work couldn’t be archived`,
  unarchive: () => t`Work couldn’t be unarchived`,
  delete: () => t`Work couldn’t be deleted`,
  restore: () => t`Couldn’t restore this Work`,
};

export function WorkCommandFailureRow({
  failure,
  onRetry,
}: {
  failure: WorkRowFailure;
  /** Replaces the plain retry, to add what else Retry does there. */
  onRetry?: () => void;
}) {
  const refusal = failure.operation === "restore" ? restoreRefusal(failure.error) : null;
  if (refusal)
    return (
      <div role="alert" className="flex items-start gap-2 pb-2">
        <p className="min-w-0 flex-1 text-sm text-destructive">{refusal}</p>
        <IconButton
          className="shrink-0 [@media(pointer:coarse)]:size-11"
          aria-label={t`Dismiss`}
          onClick={failure.dismiss}
        >
          <X aria-hidden className="size-3.5" />
        </IconButton>
      </div>
    );
  return (
    <InlineErrorRow
      message={messages[failure.operation]()}
      onRetry={onRetry ?? (() => void failure.retry())}
      onDismiss={failure.dismiss}
    />
  );
}

/** A restore the server will refuse again as it is: Retry can't help. */
function restoreRefusal(error: Error): ReactNode {
  const status = error instanceof HttpResponseError ? error.status : null;
  if (status === 409)
    return <Trans>Another Work now has this name. Rename that Work, then restore this one.</Trans>;
  if (status === 410)
    return (
      <Trans>
        This Work was deleted more than {WORK_DELETE_RETENTION_DAYS} days ago and can’t be restored.
      </Trans>
    );
  return null;
}
