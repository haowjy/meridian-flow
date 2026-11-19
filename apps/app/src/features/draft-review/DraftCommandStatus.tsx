/**
 * A listed file's status: pending delivery stays on the addressed item even when no review groups
 * remain. With nothing to report, it occupies no line.
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { RowWord } from "@/components/app/RowWord";
import { schemeLabel } from "@/features/project/context/context-schemes";
import { isDeletedLive } from "./deleted-drafts";
import { useDraftCommandState } from "./draft-changes";
/** Beside the name of a drafted document or folder its area no longer has: Apply brings it back. */
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
  const state = useDraftCommandState(itemKey);
  const content = state.unapplying ? (
    <Trans>Undoing Apply</Trans>
  ) : state.applying ? (
    <Trans>Applying</Trans>
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
