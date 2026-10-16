/**
 * Writer copy for a queued control, by kind.
 *
 * The queued row and the polite announcer that speaks its change read the
 * same string, so what a writer hears matches what they see. The row's place
 * in the queue says when it runs; the copy does not promise a moment.
 */
import { t } from "@lingui/core/macro";
import type { ControlBody } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import type { QueuedControlStatus } from "./thread-controls";

/**
 * What a pending command's row says in each status. A switch that waits for no reply
 * reads as the notice it becomes ("Switched to ..."); one that waits for a reply that
 * held the chat first (`waiting`) says it is queued.
 */
export function controlStatusCopy(
  control: ControlBody,
  status: QueuedControlStatus,
  waiting = false,
): string {
  if (control.kind === "write_mode") {
    const draft = control.mode === "draft";
    switch (status) {
      case "sending":
        return waiting
          ? draft
            ? t`Switching to draft mode`
            : t`Switching to auto-apply`
          : writeModeSwitchedCopy(control.mode);
      case "queued":
      case "withdraw_failed":
        return waiting
          ? draft
            ? t`Switch to draft mode queued`
            : t`Switch to auto-apply queued`
          : writeModeSwitchedCopy(control.mode);
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

/** What a write-mode notice says, pending or applied. */
export function writeModeSwitchedCopy(mode: AiWriteMode): string {
  return mode === "draft" ? t`Switched to draft mode` : t`Switched to auto-apply`;
}

/** What the announcer says when Stop came after the command began. */
export function controlAlreadyStartedCopy(control: ControlBody): string {
  return control.kind === "write_mode"
    ? t`This switch already happened.`
    : t`This compaction already started.`;
}

/** What the announcer says as a stopped row disappears. */
export function controlStoppedCopy(control: ControlBody): string {
  return control.kind === "write_mode" ? t`Switch stopped` : t`Compaction stopped`;
}

/** The card in a queued command's row when its Stop didn't reach the server (also announced). */
export function controlWithdrawFailedCopy(control: ControlBody): string {
  return control.kind === "write_mode"
    ? t`Couldn't stop the switch.`
    : t`Couldn't stop the compaction.`;
}

/** The Stop button's accessible name, specific so it differs from the composer's Stop. */
export function controlStopLabel(control: ControlBody): string {
  if (control.kind === "compact") return t`Stop compaction`;
  return control.mode === "draft" ? t`Stop switch to draft mode` : t`Stop switch to auto-apply`;
}

/** The Retry button's accessible name. */
export function controlRetryLabel(control: ControlBody): string {
  return control.kind === "write_mode" ? t`Retry switching` : t`Retry queueing`;
}
