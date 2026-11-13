/**
 * A listed file's status: pending delivery and same-id Retry stay on the addressed item even
 * when no review groups remain. With nothing to report, it occupies no line.
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import { isDeletedFromManuscript } from "./deleted-drafts";
import { useDraftCommandState } from "./draft-changes";
import { ReviewMessageText } from "./ReviewMessageText";
/**
 * Beside a drafted document's name when the manuscript no longer has it: Apply brings it back.
 * Nothing when it's still there.
 */
export function DeletedFromManuscriptTag({ item }: { item: ThreadDraftListItem | undefined }) {
  if (!isDeletedFromManuscript(item)) return null;
  return (
    <span
      title={t`Deleted from the manuscript. Apply brings it back.`}
      className="shrink-0 text-xs font-normal text-muted-foreground"
    >
      <Trans>Deleted</Trans>
    </span>
  );
}

export function DraftCommandStatus({ itemKey }: { itemKey: string }) {
  const owner = useDraftCommandOwner();
  const state = useDraftCommandState(itemKey);
  const content = state.stalled ? (
    <>
      {state.unapplying ? (
        <Trans>Undo is waiting for confirmation.</Trans>
      ) : (
        <Trans>Apply is waiting for confirmation.</Trans>
      )}
      <button
        type="button"
        className="text-button coarse:min-h-11"
        onClick={() => owner.retry(itemKey)}
      >
        <Trans>Retry</Trans>
      </button>
    </>
  ) : state.unapplying ? (
    <Trans>Undoing Apply</Trans>
  ) : state.applying ? (
    <Trans>Applying</Trans>
  ) : state.failure ? (
    state.failure.serverCode === "needs_restore" ? (
      <ReviewMessageText failure={state.failure} />
    ) : (
      <InlineErrorRow
        message={<ReviewMessageText failure={state.failure} />}
        className="min-w-0 flex-1 p-0"
      />
    )
  ) : null;
  if (!content) return null;
  return (
    <div
      role="status"
      className="flex min-h-7 coarse:min-h-11 items-center gap-2 px-2 text-xs text-muted-foreground"
    >
      {content}
    </div>
  );
}
