/**
 * Writer copy for a queued control, by kind.
 *
 * The queued row and the polite announcer that speaks its change read the
 * same string, so what a writer hears matches what they see. The row's place
 * in the queue says when it runs; the copy does not promise a moment.
 */
import { t } from "@lingui/core/macro";
import type { ControlBody } from "@meridian/contracts/threads";
import type { QueuedControlStatus } from "./thread-controls";

/** What the queued row says in each status. */
export function controlStatusCopy(control: ControlBody, status: QueuedControlStatus): string {
  if (control.kind === "write_mode") {
    const draft = control.mode === "draft";
    switch (status) {
      case "sending":
        return draft ? t`Switching to draft mode` : t`Switching to auto-apply`;
      case "queued":
      case "withdraw_failed":
        return draft ? t`Switch to draft mode queued` : t`Switch to auto-apply queued`;
      case "failed":
        return draft ? t`Couldn't switch to draft mode.` : t`Couldn't switch to auto-apply.`;
    }
  }
  switch (status) {
    case "sending":
    case "queued":
    case "withdraw_failed":
      return t`Compaction queued`;
    case "failed":
      return t`Couldn't queue the compaction.`;
  }
}

/** What the announcer says when Withdraw came after the command began. */
export function controlAlreadyStartedCopy(control: ControlBody): string {
  return control.kind === "write_mode"
    ? t`This switch already happened.`
    : t`This compaction already started.`;
}

/** What the announcer says as a withdrawn row disappears. */
export function controlWithdrawnCopy(control: ControlBody): string {
  return control.kind === "write_mode" ? t`Switch withdrawn` : t`Compaction withdrawn`;
}

/** The Withdraw button's accessible name. */
export function controlWithdrawLabel(control: ControlBody): string {
  return control.kind === "write_mode" ? t`Withdraw switch` : t`Withdraw compaction`;
}

/** The Retry button's accessible name. */
export function controlRetryLabel(control: ControlBody): string {
  return control.kind === "write_mode" ? t`Retry switching` : t`Retry queueing`;
}
