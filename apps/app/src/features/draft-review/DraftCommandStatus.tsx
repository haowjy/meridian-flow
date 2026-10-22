/**
 * A listed file's reserved status line: pending delivery and same-id Retry stay on the
 * addressed item even when no review groups remain. With nothing in flight it says what
 * live did to the document (deleted, or its name taken), so the line never pushes rows.
 */

import { Trans } from "@lingui/react/macro";
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import { isDeletedFromManuscript, isPathTaken } from "./deleted-drafts";
import { useDraftCommandState } from "./draft-changes";
import { ReviewMessageText } from "./ReviewMessageText";
export function DraftCommandStatus({
  itemKey,
  item,
}: {
  itemKey: string;
  /** The listed row; its conflict is the line's resting state. */
  item?: ThreadDraftListItem;
}) {
  const owner = useDraftCommandOwner();
  const state = useDraftCommandState(itemKey);
  return (
    <div
      role="status"
      className="flex min-h-7 [@media(pointer:coarse)]:min-h-11 items-center gap-2 px-2 text-caption text-ink-muted"
    >
      {state.stalled ? (
        <>
          <Trans>Apply is waiting for confirmation.</Trans>
          <button
            type="button"
            className="text-button [@media(pointer:coarse)]:min-h-11"
            onClick={() => owner.retry(itemKey)}
          >
            <Trans>Retry</Trans>
          </button>
        </>
      ) : state.applying ? (
        <Trans>Applying</Trans>
      ) : state.failure ? (
        <span className="text-destructive">
          <ReviewMessageText failure={state.failure} />
        </span>
      ) : isPathTaken(item) ? (
        <Trans>Another document now has this name. Rename it to apply this draft.</Trans>
      ) : isDeletedFromManuscript(item) ? (
        <Trans>Deleted from the manuscript</Trans>
      ) : null}
    </div>
  );
}
