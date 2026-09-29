/**
 * Writer copy for a queued command, per command kind.
 *
 * The queued row and the polite announcer that speaks its change read the
 * same string, so what a writer hears matches what they see.
 */
import { t } from "@lingui/core/macro";
import type { ControlBody } from "@meridian/contracts/threads";
import type { QueuedControlStatus } from "./thread-controls";

type ControlKind = ControlBody["kind"];

/** What the queued row says in each status. */
export function controlStatusCopy(kind: ControlKind, status: QueuedControlStatus): string {
  const compact = kind === "compact";
  switch (status) {
    case "queued":
    case "withdraw_failed":
      return compact
        ? t`Compaction queued. Runs when replies finish.`
        : t`Undo queued. Runs when replies finish.`;
    case "failed":
      return compact ? t`Couldn't queue the compaction.` : t`Couldn't queue the undo.`;
    case "already_started":
      return compact ? t`This compaction already started.` : t`This undo already started.`;
  }
}

/** What the announcer says as a withdrawn row disappears. */
export function controlWithdrawnCopy(kind: ControlKind): string {
  return kind === "compact" ? t`Compaction withdrawn` : t`Undo withdrawn`;
}
