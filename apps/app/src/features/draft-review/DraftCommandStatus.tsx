/**
 * A listed file's status: pending delivery stays on the addressed item even when no review groups
 * remain. With nothing to report, it occupies no line.
 */

import { Trans } from "@lingui/react/macro";
import { useDraftCommandState } from "./draft-changes";

export function DraftCommandStatus({ itemKey }: { itemKey: string }) {
  const state = useDraftCommandState(itemKey);
  if (!state.applying) return null;
  return (
    <div
      role="status"
      className="flex min-h-7 coarse:min-h-11 items-center gap-2 px-2 text-xs text-muted-foreground"
    >
      <Trans>Applying</Trans>
    </div>
  );
}
