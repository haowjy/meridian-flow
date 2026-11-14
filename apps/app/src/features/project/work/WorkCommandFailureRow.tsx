/**
 * A Work command the server refused, as the Work list, the Work band and the
 * phone top bar show it: what failed, Retry where it can help, and Dismiss.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import type { WorkCommandFailure } from "@/client/query/work-command-selectors";
import type { WorkCommandRefused } from "@/client/query/work-mutations";
import { workUpdateFailure } from "@/client/query/work-update-failure";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";

/** The commands whose failure stays on the Work until the writer acts on it. */
export const WORK_ROW_OPERATIONS = ["update", "archive", "unarchive", "delete", "restore"] as const;

export type WorkRowFailure = WorkCommandFailure<(typeof WORK_ROW_OPERATIONS)[number]>;

const messages: { [Op in WorkRowFailure["operation"]]: () => string } = {
  update: () => t`Couldn’t save this change to the Work`,
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
  const explained = workUpdateFailure(failure.error, "");
  return {
    message:
      explained ||
      (name && failure.operation === "restore"
        ? t`Couldn’t restore ${name}`
        : messages[failure.operation]()),
    // Retry only where a second try can succeed.
    onRetry: failure.error.retryable ? (onRetry ?? (() => void failure.retry())) : undefined,
    onDismiss: failure.dismiss,
  };
}

/** A restore the server will refuse again as it is: Retry can't help. */
function restoreRefusal(error: WorkCommandRefused, name?: string): ReactNode {
  if (error.code !== "work_not_found") return null;
  return name ? <Trans>{name} is gone from Trash.</Trans> : <Trans>Gone from Trash.</Trans>;
}
