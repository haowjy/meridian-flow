/**
 * A listed file's status: pending delivery and same-id Retry stay on the addressed item even
 * when no review groups remain. With nothing to report, it occupies no line.
 */

import { Trans } from "@lingui/react/macro";
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import { isDeletedFromManuscript } from "./deleted-drafts";
import { useDraftCommandState } from "./draft-changes";
import { ReviewMessageText } from "./ReviewMessageText";
export function DraftCommandStatus({
  itemKey,
  item,
}: {
  itemKey: string;
  /** The listed row supplies its live deletion state. */
  item?: ThreadDraftListItem;
}) {
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
        className="text-button [@media(pointer:coarse)]:min-h-11"
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
    <span className={state.failure.serverCode === "needs_restore" ? undefined : "text-destructive"}>
      <ReviewMessageText failure={state.failure} />
    </span>
  ) : isDeletedFromManuscript(item) ? (
    <Trans>Deleted from the manuscript</Trans>
  ) : null;
  if (!content) return null;
  return (
    <div
      role="status"
      className="flex min-h-7 [@media(pointer:coarse)]:min-h-11 items-center gap-2 px-2 text-caption text-ink-muted"
    >
      {content}
    </div>
  );
}
