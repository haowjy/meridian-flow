/**
 * Writer copy for a queued `/compact`.
 *
 * The queued row and the polite announcer that speaks its change read the
 * same string, so what a writer hears matches what they see.
 */
import { t } from "@lingui/core/macro";
import type { QueuedControlStatus } from "./thread-controls";

/** What the queued row says in each status. */
export function controlStatusCopy(status: QueuedControlStatus): string {
  switch (status) {
    case "queued":
    case "withdraw_failed":
      return t`Compaction queued. Runs when replies finish.`;
    case "failed":
      return t`Couldn't queue the compaction.`;
    case "already_started":
      return t`This compaction already started.`;
  }
}

/** What the announcer says as a withdrawn row disappears. */
export function controlWithdrawnCopy(): string {
  return t`Compaction withdrawn`;
}
