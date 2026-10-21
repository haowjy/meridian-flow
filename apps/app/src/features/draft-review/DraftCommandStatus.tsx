/** Pending delivery and same-id Retry remain on the addressed item, even when no review groups remain. */
import { Trans } from "@lingui/react/macro";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import { useDraftCommandState } from "./draft-changes";
import { ReviewMessageText } from "./ReviewMessageText";
export function DraftCommandStatus({ itemKey }: { itemKey: string }) {
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
      ) : null}
    </div>
  );
}
