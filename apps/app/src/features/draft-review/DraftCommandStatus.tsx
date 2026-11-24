/** A listed file's status while a press applies it. With nothing to report, it occupies no line. */

import { Trans } from "@lingui/react/macro";
import { useSyncExternalStore } from "react";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";

export function DraftCommandStatus({ itemKey }: { itemKey: string }) {
  const owner = useDraftCommandOwner();
  const snapshot = () => owner.state(itemKey);
  const state = useSyncExternalStore(owner.subscribe, snapshot, snapshot);
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
