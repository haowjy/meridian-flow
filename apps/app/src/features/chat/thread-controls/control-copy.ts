import { t } from "@lingui/core/macro";
import type { ControlBody } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import type { QueuedControlStatus } from "./thread-controls";

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

export function writeModeSwitchedCopy(mode: AiWriteMode): string {
  return mode === "draft" ? t`Switched to draft mode` : t`Switched to auto-apply`;
}

export function controlAlreadyStartedCopy(control: ControlBody): string {
  return control.kind === "write_mode"
    ? t`This switch already happened.`
    : t`This compaction already started.`;
}

export function controlWithdrawnCopy(control: ControlBody): string {
  return control.kind === "write_mode" ? t`Switch undone` : t`Compaction stopped`;
}

export function controlWithdrawFailedCopy(control: ControlBody): string {
  return control.kind === "write_mode" ? t`Couldn't undo` : t`Couldn't stop the compaction`;
}

export function controlWithdrawText(control: ControlBody): string {
  return control.kind === "compact" ? t`Stop` : t`Undo`;
}

export function controlWithdrawLabel(control: ControlBody): string {
  if (control.kind === "compact") return t`Stop compaction`;
  return control.mode === "draft" ? t`Undo switch to draft mode` : t`Undo switch to auto-apply`;
}
