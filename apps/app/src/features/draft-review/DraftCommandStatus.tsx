/**
 * A listed file's status: pending delivery and same-id Retry stay on the addressed item even
 * when no review groups remain. With nothing to report, it occupies no line.
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { RowWord } from "@/components/app/RowWord";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import { schemeLabel } from "@/features/project/context/context-schemes";
import { isDeletedLive } from "./deleted-drafts";
import { useDraftCommandState } from "./draft-changes";
import { ReviewMessageText } from "./ReviewMessageText";
/** Beside the name of a drafted document its area no longer has: Apply brings it back. */
export function DeletedWord({ scheme }: { scheme: ProjectContextTreeScheme | null | undefined }) {
  const area = schemeLabel(scheme);
  return (
    <RowWord
      tone="note"
      word={<Trans>Deleted</Trans>}
      sentence={
        area ? t`Deleted from ${area}. Apply brings it back.` : t`Deleted. Apply brings it back.`
      }
    />
  );
}

/** `DeletedWord` for a drafted document live deleted; nothing when it's still there. */
export function DeletedLiveTag({ item }: { item: ThreadDraftListItem | undefined }) {
  return isDeletedLive(item) ? <DeletedWord scheme={item?.deletedFrom?.scheme} /> : null;
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
    state.failure.code !== "undo-left-out" && state.failure.serverCode === "needs_restore" ? (
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
