/**
 * A Work command the server refused, as the Work list, the Work band and the
 * phone top bar show it: what failed, Retry where it can help, and Dismiss.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { DELETION_RETENTION_DAYS as WORK_DELETE_RETENTION_DAYS } from "@meridian/contracts/retention";
import type { ReactNode } from "react";
import { HttpResponseError } from "@/client/api/http-client";
import type { WorkCommandFailure } from "@/client/query/work-command-selectors";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";

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
  const line = workFailureLine(failure, { onRetry });
  return <InlineErrorRow {...line} className={line.onRetry ? undefined : "px-0 pt-0 pb-2"} />;
}

/**
 * What the failure line says and offers: Retry only where it can help. `name` is for a line
 * shown where the Work itself no longer is (the Work list's Undo line), so it names the Work.
 */
export function workFailureLine(
  failure: WorkRowFailure,
  { onRetry, name }: { onRetry?: () => void; name?: string } = {},
) {
  const refusal = failure.operation === "restore" ? restoreRefusal(failure.error, name) : null;
  if (refusal) return { message: refusal, onDismiss: failure.dismiss };
  return {
    message:
      name && failure.operation === "restore"
        ? t`Couldn’t restore ${name}`
        : messages[failure.operation](),
    onRetry: onRetry ?? (() => void failure.retry()),
    onDismiss: failure.dismiss,
  };
}

/** A restore the server will refuse again as it is: Retry can't help. */
function restoreRefusal(error: Error, name?: string): ReactNode {
  const status = error instanceof HttpResponseError ? error.status : null;
  if (status === 409)
    return name ? (
      <Trans>Another Work is now named {name}. Rename that Work, then restore this one.</Trans>
    ) : (
      <Trans>Another Work now has this name. Rename that Work, then restore this one.</Trans>
    );
  if (status === 410)
    return name ? (
      <Trans>
        {name} was deleted more than {WORK_DELETE_RETENTION_DAYS} days ago and can’t be restored.
      </Trans>
    ) : (
      <Trans>
        This Work was deleted more than {WORK_DELETE_RETENTION_DAYS} days ago and can’t be restored.
      </Trans>
    );
  return null;
}
