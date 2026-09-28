/**
 * Writer copy for a queued control's status, per control kind.
 *
 * The row (or divider) that shows the control and the polite announcer that
 * speaks its change read the same string, so what a writer hears matches what
 * they see.
 */
import { t } from "@lingui/core/macro";
import type { ControlBody } from "@meridian/contracts/threads";
import type { QueuedControlStatus } from "./thread-controls";

type ControlKind = ControlBody["kind"];

export function controlStatusCopy(kind: ControlKind, status: QueuedControlStatus): string {
  switch (status) {
    case "queued":
    case "withdraw_failed":
      return kind === "compact"
        ? t`Compaction queued`
        : kind === "compaction_undo"
          ? t`Undo queued`
          : t`Handoff brief queued`;
    case "failed":
      return kind === "compact"
        ? t`Couldn't queue the compaction.`
        : kind === "compaction_undo"
          ? t`Couldn't queue the undo.`
          : t`Couldn't queue the handoff brief.`;
    case "withdrawing":
      return kind === "compact"
        ? t`Withdrawing compaction`
        : kind === "compaction_undo"
          ? t`Withdrawing undo`
          : t`Withdrawing handoff brief`;
    case "withdrawn":
      return kind === "compact"
        ? t`Compaction withdrawn`
        : kind === "compaction_undo"
          ? t`Undo withdrawn`
          : t`Handoff brief withdrawn`;
    case "stopping":
      return kind === "compact" ? t`Stopping compaction` : t`Stopping`;
    case "already_finished":
      return kind === "compact"
        ? t`This compaction already ran.`
        : kind === "compaction_undo"
          ? t`This undo already ran.`
          : t`This handoff brief already ran.`;
  }
}
